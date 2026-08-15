// Unit tests for the gateway's pure decision logic. Run with `bun test`.
// These cover every classification branch that routing/failover depends on.

import { describe, expect, test } from "bun:test";
import { classifyStatus, isContextOverflowError, parseEmbeddedError, parseRetryAfter } from "../src/upstream";
import { resolveCandidates, routeExists, setCooldown, inCooldown } from "../src/router";

describe("classifyStatus", () => {
	test("429 -> rate-limit", () => {
		expect(classifyStatus(429)).toEqual({ kind: "rate-limit" });
	});
	test("401/402/403 -> auth-error", () => {
		expect(classifyStatus(401)).toEqual({ kind: "auth-error" });
		expect(classifyStatus(402)).toEqual({ kind: "auth-error" });
		expect(classifyStatus(403)).toEqual({ kind: "auth-error" });
	});
	test("404/408/5xx -> retryable", () => {
		expect(classifyStatus(404)).toEqual({ kind: "retryable" });
		expect(classifyStatus(408)).toEqual({ kind: "retryable" });
		expect(classifyStatus(500)).toEqual({ kind: "retryable" });
		expect(classifyStatus(503)).toEqual({ kind: "retryable" });
	});
	test("other 4xx -> fatal", () => {
		expect(classifyStatus(400)).toEqual({ kind: "fatal" });
		expect(classifyStatus(422)).toEqual({ kind: "fatal" });
	});
});

describe("isContextOverflowError", () => {
	test("matches provider context-overflow messages", () => {
		expect(isContextOverflowError(400, "This model's maximum context length is 8192 tokens")).toBe(true);
		expect(isContextOverflowError(400, '{"code":"context_length_exceeded"}')).toBe(true);
		expect(isContextOverflowError(400, "prompt is too long: 105000 tokens > 200000 maximum")).toBe(true);
		expect(isContextOverflowError(413, "too many input tokens")).toBe(true);
		expect(isContextOverflowError(400, "\u8f93\u5165token\u8d85\u51fa\u6a21\u578b\u4e0a\u4e0b\u6587\u957f\u5ea6\u9650\u5236")).toBe(true);
		expect(isContextOverflowError(400, "Please reduce the length of the messages.")).toBe(true);
	});
	test("does not match non-overflow errors", () => {
		expect(isContextOverflowError(400, "max_tokens is too large: 200000 > 131072")).toBe(false);
		expect(isContextOverflowError(400, "Invalid parameter: temperature must be a number")).toBe(false);
	});
	test("status gate", () => {
		expect(isContextOverflowError(401, "maximum context length is 8192")).toBe(false);
	});
});

describe("parseEmbeddedError (OpenRouter 200-envelope)", () => {
	test("top-level error object", () => {
		const body = '\n        {"error":{"message":"Upstream error from Nvidia: Internal server error","code":502}}';
		expect(parseEmbeddedError(body)).toEqual({
			code: 502,
			message: "Upstream error from Nvidia: Internal server error",
		});
	});
	test("finish_reason error inside choices", () => {
		expect(parseEmbeddedError('{"choices":[{"index":0,"delta":{},"finish_reason":"error"}]}')).toEqual({
			code: 502,
			message: "upstream finished with error",
		});
	});
	test("valid completions pass", () => {
		expect(parseEmbeddedError('{"choices":[{"finish_reason":"stop","message":{"content":"ok"}}]}')).toBeNull();
		expect(parseEmbeddedError('{"id":"x","choices":[{"finish_reason":"stop"}],"usage":{}}')).toBeNull();
	});
	test("non-JSON passes", () => {
		expect(parseEmbeddedError("data: {\"x\":1}\n\ndata: [DONE]")).toBeNull();
	});
});

describe("parseRetryAfter", () => {
	test("numeric seconds", () => {
		const res = new Response(null, { headers: { "retry-after": "30" } });
		expect(parseRetryAfter(res, 60)).toBe(30);
	});
	test("missing header -> fallback", () => {
		expect(parseRetryAfter(new Response(null), 60)).toBe(60);
	});
	test("garbage header -> fallback", () => {
		const res = new Response(null, { headers: { "retry-after": "soon-ish" } });
		expect(parseRetryAfter(res, 60)).toBe(60);
	});
});

describe("router", () => {
	test("auto: sticky tier-0 first, floor model last", () => {
		const c = resolveCandidates("auto");
		expect(c).not.toBeNull();
		expect(c!.length).toBe(8);
		expect(c![0]!.provider.name).toBe("lfree");
		expect(c![0]!.model).toBe("deepseek-v4-flash");
		expect(c![c!.length - 1]!.provider.name).toBe("openrouter");
	});
	test("tier-1 members come from ark-plan/ark-coding", () => {
		const c = resolveCandidates("auto")!;
		const tier1 = c.slice(1, 7).map((t) => t.provider.name);
		for (const name of tier1) {
			expect(name === "ark-plan" || name === "ark-coding").toBe(true);
		}
	});
	test("direct provider/model form", () => {
		const c = resolveCandidates("ark-plan/glm-5.3");
		expect(c).not.toBeNull();
		expect(c!.length).toBe(1);
		expect(c![0]!.model).toBe("glm-5.3");
	});
	test("unknown model -> null", () => {
		expect(resolveCandidates("nope")).toBeNull();
	});
	test("routeExists", () => {
		expect(routeExists("auto")).toBe(true);
		expect(routeExists("ark-plan/glm-5.3")).toBe(true);
		expect(routeExists("nope")).toBe(false);
	});
	test("cooldown removes tier-0 from candidates", () => {
		expect(inCooldown("lfree")).toBe(false);
		setCooldown("lfree", 60);
		const c = resolveCandidates("auto")!;
		expect(c[0]!.provider.name).not.toBe("lfree");
	});
});
