// Upstream call: request rewrite, timeout, and failure classification.

import { DEFAULT_TIMEOUT_MS } from "./config";
import type { ProviderConfig } from "./config";
import type { ResolvedTarget } from "./router";

/** How to react to an upstream failure. */
export type FailureAction =
	| { kind: "rate-limit" } // 429: cooldown provider, failover
	| { kind: "auth-error" } // 401/402/403: long cooldown, failover
	| { kind: "retryable" } // 408/5xx/network/timeout: failover, no cooldown
	| { kind: "fatal" }; // other 4xx: client request is bad, pass through

export function classifyStatus(status: number): FailureAction {
	if (status === 429) return { kind: "rate-limit" };
	if (status === 401 || status === 402 || status === 403) return { kind: "auth-error" };
	// 404 = upstream does not serve this model name (renamed/retired model in a
	// mixed-model chain). Best practice: fail over per-request to the next
	// candidate WITHOUT parking the provider - it may still serve other models.
	if (status === 404 || status === 408 || status >= 500) return { kind: "retryable" };
	return { kind: "fatal" };
}

// Context-overflow message patterns mapped across providers (same approach as
// LiteLLM's exception mapping for ContextWindowExceededError). Matching these
// means "this input does not fit THIS model's window": the next candidate may
// have a larger window, so the request should fail over (and the provider must
// NOT be parked - it is healthy for smaller requests).
const CONTEXT_OVERFLOW_PATTERNS: RegExp[] = [
	/context_length_exceeded/i,
	/maximum context length/i,
	/exceed(?:s|ed)? (?:the )?context (?:window|length|limit)/i,
	/context (?:window|length)[^."]{0,40}exceed/i,
	/prompt is too long/i,
	/context window (?:is )?full/i,
	/token limit exceeded/i,
	/reduce the length of (?:the |your )?(?:messages|prompt|input)/i,
	/input (?:tokens?|length) (?:is |are )?too (?:long|large)/i,
	/too many (?:input )?tokens/i,
	/\u8d85\u51fa.{0,12}(?:\u4e0a\u4e0b\u6587|\u957f\u5ea6|token)/i,
	/(?:\u4e0a\u4e0b\u6587|\u957f\u5ea6|token).{0,12}(?:\u8d85\u9650|\u8d85\u51fa|\u8d85\u8fc7)/i,
];

/**
 * Distinguish "input larger than this model's context window" from generic
 * bad requests. Only called for statuses that classifyStatus marks as fatal.
 */
export function isContextOverflowError(status: number, bodyText: string): boolean {
	if (status !== 400 && status !== 413 && status !== 422) return false;
	return CONTEXT_OVERFLOW_PATTERNS.some((re) => re.test(bodyText));
}

export interface EmbeddedError {
	code: number;
	message: string;
}

/**
 * Detect OpenRouter's DOCUMENTED provider-failure envelope: once a request is
 * accepted, OpenRouter always answers HTTP 200 and carries generation-time
 * failures (provider 5xx / capacity / moderation) inside the body - either a
 * top-level `error` object, or choices[0].finish_reason === "error"
 * (see openrouter.ai/docs/api-reference/errors). Only meaningful for complete
 * non-streaming JSON bodies; never call on streaming responses.
 */
export function parseEmbeddedError(bodyText: string): EmbeddedError | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(bodyText);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const obj = parsed as {
		error?: { code?: unknown; message?: unknown };
		choices?: Array<{ finish_reason?: unknown }>;
	};
	const err = obj.error;
	if (typeof err === "object" && err !== null) {
		const code = typeof err.code === "number" ? err.code : 502;
		const message = typeof err.message === "string" ? err.message : "upstream embedded error";
		return { code, message };
	}
	const choice = obj.choices?.[0];
	if (choice !== undefined && choice.finish_reason === "error") {
		return { code: 502, message: "upstream finished with error" };
	}
	return null;
}

export interface UpstreamCallInput {
	target: ResolvedTarget;
	apiKey: string;
	/** Request path below the provider base URL, e.g. "/chat/completions". */
	path: string;
	/** Parsed request body; "model" will be overwritten with the upstream name. */
	body: Record<string, unknown>;
	requestId: string;
}

/**
 * Forward a chat completion to one upstream provider.
 * Resolves as soon as response HEADERS arrive (failover decision point);
 * the body is streamed later by the caller without buffering.
 */
export function callUpstream(input: UpstreamCallInput): Promise<Response> {
	const { target, apiKey, path, body, requestId } = input;
	const provider: ProviderConfig = target.provider;

	const upstreamBody = { ...body, model: target.model };
	const timeoutMs = provider.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	const url = `${provider.baseUrl}${path}`;
	const init: RequestInit = {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"authorization": `Bearer ${apiKey}`,
			"accept": "*/*",
			"x-gw-request-id": requestId,
		},
		body: JSON.stringify(upstreamBody),
		signal: controller.signal,
	};

	return fetch(url, init).finally(() => clearTimeout(timer)) as Promise<Response>;
}

/** Parse Retry-After (seconds or HTTP date), clamped to [min, max] seconds. */
export function parseRetryAfter(response: Response, fallbackS: number): number {
	const header = response.headers.get("retry-after");
	if (header === null) return fallbackS;
	const asSeconds = Number(header);
	if (Number.isFinite(asSeconds) && asSeconds >= 0) {
		return Math.min(Math.max(asSeconds, 1), 3600);
	}
	const asDate = Date.parse(header);
	if (!Number.isNaN(asDate)) {
		return Math.min(Math.max(Math.ceil((asDate - Date.now()) / 1000), 1), 3600);
	}
	return fallbackS;
}
