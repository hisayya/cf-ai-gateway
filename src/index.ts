// cf-ai-gateway: OpenAI-compatible multi-provider gateway on Cloudflare Workers.
// Flow: client -> auth -> model resolution (alias or provider/model) ->
// weighted load balancing -> failover on 429/5xx/auth errors -> SSE/JSON
// pass-through without buffering.

import {
	MODEL_ROUTES,
	PROVIDERS,
	GATEWAY_KEY_SECRET,
	RATE_LIMIT_COOLDOWN_S,
	TRUNCATION_COOLDOWN_S,
	AUTH_ERROR_COOLDOWN_S,
} from "./config";
import { resolveCandidates, routeExists, setCooldown, cooldownRemainingS } from "./router";
import { callUpstream, classifyStatus, isContextOverflowError, parseEmbeddedError, parseRetryAfter } from "./upstream";

interface Env {
	// Secrets and vars are both plain strings at runtime.
	[key: string]: string | undefined;
}

interface AttemptLog {
	provider: string;
	status: number;
	detail: string;
}

const CORS_HEADERS: Record<string, string> = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET, POST, OPTIONS",
	"access-control-allow-headers": "authorization, content-type",
};

/** Max bytes of an upstream error body kept for diagnostics. */
const ERROR_SNIPPET_BYTES = 512;

/** Request body cap. 1M-token prompts are ~4-8MB of JSON; 20MB leaves ample
 * headroom while blocking memory-exhaustion payloads (dual check: declared
 * Content-Length up front, actual body length after read -> 413). */
const MAX_REQUEST_BODY_BYTES = 20 * 1024 * 1024;

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: CORS_HEADERS });
		}

		// Malformed/host-less requests (e.g. internet port-scanner probes) carry a
		// non-absolute url that would throw in URL parsing. RFC 7230 §5.4: answer
		// malformed requests with 400 Bad Request instead of crashing.
		let path: string;
		try {
			path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
		} catch {
			return json({ error: { message: "Bad request: invalid request target or missing Host header", type: "invalid_request_error", code: 400 } }, 400);
		}
		if (path === "/health") return json({ ok: true, providers: PROVIDERS.length, routes: MODEL_ROUTES.length }, 200);

		if (path === "/v1/models" || path === "/models") {
			const authFailure = checkAuth(request, env);
			if (authFailure !== null) return authFailure;
			return json(
				{
					object: "list",
					data: MODEL_ROUTES.map((r) => ({
						id: r.alias,
						object: "model",
						created: 0,
						owned_by: "cf-ai-gateway",
					})),
				},
				200,
			);
		}

		const isCompletion =
			path === "/v1/chat/completions" || path === "/chat/completions";
		const isLegacyCompletion = path === "/v1/completions" || path === "/completions";
		if (isCompletion || isLegacyCompletion) {
			const authFailure = checkAuth(request, env);
			if (authFailure !== null) return authFailure;
			return handleCompletion(request, env, isLegacyCompletion ? "/completions" : "/chat/completions");
		}

		logNotFound("unknown_path", path);
		return openAIError(404, "not_found", `unknown path: ${path}`);
	},
} satisfies ExportedHandler<Env>;

function logNotFound(kind: "unknown_path" | "unknown_model", detail: string): void {
	console.log(JSON.stringify({ level: "warn", event: kind, detail }));
}

async function handleCompletion(request: Request, env: Env, upstreamPath: string): Promise<Response> {
	if (request.method !== "POST") {
		return openAIError(405, "method_not_allowed", "use POST");
	}

	// Pre-read guard: a lying-low or absent Content-Length is caught after read.
	const declaredLength = Number(request.headers.get("content-length") ?? "0");
	if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
		return openAIError(413, "request_too_large", `request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`);
	}

	let body: Record<string, unknown>;
	try {
		const raw = await request.text();
		if (raw.length > MAX_REQUEST_BODY_BYTES) {
			return openAIError(413, "request_too_large", `request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`);
		}
		body = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return openAIError(400, "invalid_request_error", "request body is not valid JSON");
	}

	const requestedModel = body["model"];
	if (typeof requestedModel !== "string" || requestedModel.length === 0) {
		return openAIError(400, "invalid_request_error", "missing string field: model");
	}

	const candidates = resolveCandidates(requestedModel);
	if (candidates === null) {
		if (routeExists(requestedModel)) {
			const cooling = PROVIDERS.map((p) => `${p.name}:${cooldownRemainingS(p.name)}s`).join(" ");
			return openAIError(503, "upstream_unavailable", `all upstreams for "${requestedModel}" are cooling down [${cooling}]`);
		}
		const known = MODEL_ROUTES.map((r) => r.alias).join(", ");
		logNotFound("unknown_model", requestedModel);
		return openAIError(404, "model_not_found", `unknown model "${requestedModel}". available: ${known}`);
	}

	const requestId = crypto.randomUUID();
	const startedAt = Date.now();

	// Streaming requests get an IMMEDIATE SSE response with keep-alive
	// comments flowing from t=0: some upstreams (lfree) stay completely
	// silent, before even sending headers, for 8s+ while thinking, and
	// byte-idle read timeouts in clients abort the request during that
	// window. Failover for streams happens inside the SSE pump.
	if (body["stream"] === true) {
		return streamCompletion(candidates, env, upstreamPath, body, requestedModel, requestId, startedAt);
	}

	const attempts: AttemptLog[] = [];

	for (const target of candidates) {
		const apiKey = env[target.provider.keySecret];
		if (apiKey === undefined || apiKey.length === 0) {
			attempts.push({ provider: target.provider.name, status: 0, detail: `secret not set: ${target.provider.keySecret}` });
			continue;
		}

		let upstreamRes: Response;
		try {
			upstreamRes = await callUpstream({
				target,
				apiKey,
				path: upstreamPath,
				body,
				requestId,
			});
		} catch (err) {
			const isAbort = err instanceof Error && err.name === "AbortError";
			attempts.push({
				provider: target.provider.name,
				status: 0,
				detail: isAbort ? "timeout waiting for headers" : String(err),
			});
			continue;
		}

		if (upstreamRes.ok) {
			// Non-streaming responses are complete JSON: inspect them for
			// OpenRouter's documented "HTTP 200 + embedded error" envelope
			// (provider failures after the request was accepted) and fail over
			// instead of forwarding a 200 that no client can use.
			const text = await upstreamRes.text();
			const embedded = parseEmbeddedError(text);
			if (embedded !== null) {
				attempts.push({
					provider: target.provider.name,
					status: embedded.code,
					detail: `embedded-error: ${embedded.message}`,
				});
				console.log(
					JSON.stringify({
						requestId,
						model: requestedModel,
						provider: target.provider.name,
						upstreamModel: target.model,
						status: embedded.code,
						embeddedError: true,
						ms: Date.now() - startedAt,
					}),
				);
				if (embedded.code === 429) {
					setCooldown(target.provider.name, RATE_LIMIT_COOLDOWN_S);
				}
				continue;
			}
			console.log(
			JSON.stringify({
				// "warn" per production-logging convention: recovered via failover.
				level: attempts.length > 0 ? "warn" : "info",
				requestId,
				model: requestedModel,
				provider: target.provider.name,
				upstreamModel: target.model,
				status: upstreamRes.status,
				ms: Date.now() - startedAt,
				// Full history of the candidates that were skipped before this
				// one succeeded, so failover causes are auditable after the fact.
				...(attempts.length > 0 ? { attempts } : {}),
			}),
		);
		return passThrough(upstreamRes, target, requestId, text);
	}

		// Error path: body is small, safe to read fully for diagnostics.
		const detail = snippet(await upstreamRes.text());

		const action = classifyStatus(upstreamRes.status);
		// Context overflow (input larger than THIS model's window) is not a bad
		// request: the next candidate may have a larger window. LiteLLM models
		// this as context_window_fallbacks - fail over, park nothing.
		if (action.kind === "fatal" && isContextOverflowError(upstreamRes.status, detail)) {
			attempts.push({
				provider: target.provider.name,
				status: upstreamRes.status,
				detail: `context-overflow ${detail}`,
			});
			console.log(
				JSON.stringify({
					requestId,
					model: requestedModel,
					provider: target.provider.name,
					upstreamModel: target.model,
					status: upstreamRes.status,
					contextOverflow: true,
				}),
			);
			continue;
		}
		attempts.push({ provider: target.provider.name, status: upstreamRes.status, detail });
		if (action.kind === "rate-limit") {
			setCooldown(target.provider.name, parseRetryAfter(upstreamRes, RATE_LIMIT_COOLDOWN_S));
			continue;
		}
		if (action.kind === "auth-error") {
			// Upstream credential rejected: mark provider unusable, try next.
			setCooldown(target.provider.name, AUTH_ERROR_COOLDOWN_S);
			continue;
		}
		if (action.kind === "retryable") {
			continue;
		}
		// fatal 4xx: the request itself is invalid for this upstream model
		// (bad params, context length, unknown model...). Retrying elsewhere
		// rarely helps and hides the real error, so surface it to the client.
		console.log(
			JSON.stringify({
				requestId,
				model: requestedModel,
				provider: target.provider.name,
				upstreamModel: target.model,
				status: upstreamRes.status,
				fatal: true,
				detail,
			}),
		);
		return new Response(detail, {
			status: upstreamRes.status,
			headers: { "content-type": upstreamContentType(upstreamRes), ...CORS_HEADERS },
		});
	}

	console.log(JSON.stringify({ requestId, model: requestedModel, status: 502, attempts }));
	return openAIError(
		502,
		"upstream_error",
		`all ${attempts.length} upstream attempts failed`,
		attempts,
		requestId,
	);
}

/** Forward a successful upstream response. Zero-buffer for streams; a
 * pre-read string body (already validated, no embedded error) otherwise. */
function passThrough(
	res: Response,
	target: { provider: { name: string }; model: string },
	requestId: string,
	textBody?: string,
): Response {
	const headers = buildUpstreamHeaders(res, target, requestId);
	return new Response(textBody ?? res.body, { status: res.status, headers });
}

function buildUpstreamHeaders(
	res: Response,
	target: { provider: { name: string }; model: string },
	requestId: string,
): Headers {
	const headers = new Headers(CORS_HEADERS);
	headers.set("content-type", upstreamContentType(res));
	for (const name of ["retry-after", "x-ratelimit-limit-requests", "x-ratelimit-remaining-requests", "x-ratelimit-reset-requests"]) {
		const v = res.headers.get(name);
		if (v !== null) headers.set(name, v);
	}
	headers.set("x-gw-provider", target.provider.name);
	headers.set("x-gw-model", target.model);
	headers.set("x-gw-request-id", requestId);
	return headers;
}

/** Silence threshold (ms) before injecting an SSE comment keep-alive. lfree
 * buffers its entire thinking phase server-side and emits ZERO bytes - not
 * even response headers - for ~8s+ (longer on big prompts); byte-idle read
 * timeouts in clients (httpx default ~5s) then abort the request mid-wait.
 * Per the SSE spec, lines starting with ':' are comments ignored by every
 * parser - including the OpenAI SDKs - so injecting them keeps the connection
 * observably alive without changing the payload the client sees. */
const SSE_HEARTBEAT_MS = 2_000;

/**
 * Streaming completion handler: returns an SSE response IMMEDIATELY (bytes
 * flow to the client from t=0), then walks the candidate list inside the
 * stream pump. Heartbeat comments cover every silent window: while waiting
 * for upstream headers AND while an upstream itself goes quiet mid-stream.
 * Once a chosen upstream starts producing, its chunks are forwarded verbatim.
 */
function streamCompletion(
	candidates: ReturnType<typeof resolveCandidates>,
	env: Env,
	upstreamPath: string,
	body: Record<string, unknown>,
	requestedModel: string,
	requestId: string,
	startedAt: number,
): Response {
	const encoder = new TextEncoder();
	const headers = new Headers(CORS_HEADERS);
	headers.set("content-type", "text/event-stream");
	headers.set("cache-control", "no-cache");
	headers.set("x-gw-request-id", requestId);
	headers.set("x-accel-buffering", "no");

	const attempts: AttemptLog[] = [];
	let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	// Assigned once the winning upstream starts pumping; lets cancel()
	// (client disconnect) emit the same terminal stream_end event.
	let logStreamEnd: ((reason: "upstream_done" | "upstream_error" | "client_cancel") => void) | undefined;

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const write = (s: string): void => {
				controller.enqueue(encoder.encode(s));
			};
			let timer: ReturnType<typeof setInterval> | undefined;
			const restartHeartbeat = (): void => {
				if (timer !== undefined) clearInterval(timer);
				timer = setInterval(() => {
					try {
						write(": keep-alive\n\n");
					} catch {
						/* client disconnected */
					}
				}, SSE_HEARTBEAT_MS);
			};
			// One immediate comment so the response body starts flowing now.
			write(": cf-ai-gateway stream open\n\n");
			restartHeartbeat();
			try {
				for (const target of candidates!) {
					const apiKey = env[target.provider.keySecret];
					if (apiKey === undefined || apiKey.length === 0) {
						attempts.push({ provider: target.provider.name, status: 0, detail: `secret not set: ${target.provider.keySecret}` });
						continue;
					}

					let upstreamRes: Response;
					try {
						upstreamRes = await callUpstream({ target, apiKey, path: upstreamPath, body, requestId });
					} catch (err) {
						const isAbort = err instanceof Error && err.name === "AbortError";
						attempts.push({
							provider: target.provider.name,
							status: 0,
							detail: isAbort ? "timeout waiting for headers" : String(err),
						});
						continue;
					}

					if (!upstreamRes.ok || upstreamRes.body === null) {
						const detail = snippet(await upstreamRes.text());
						attempts.push({ provider: target.provider.name, status: upstreamRes.status, detail });
						const action = classifyStatus(upstreamRes.status);
						if (action.kind === "rate-limit") {
							setCooldown(target.provider.name, parseRetryAfter(upstreamRes, RATE_LIMIT_COOLDOWN_S));
							continue;
						}
						if (action.kind === "auth-error") {
							setCooldown(target.provider.name, AUTH_ERROR_COOLDOWN_S);
							continue;
						}
						if (action.kind === "retryable") {
							continue;
						}
						// fatal 4xx: surface as an in-stream error event (the
						// 200 + SSE headers have already been committed).
						console.log(
							JSON.stringify({ requestId, model: requestedModel, provider: target.provider.name, upstreamModel: target.model, status: upstreamRes.status, fatal: true, detail }),
						);
						write(`data: ${JSON.stringify({ error: { message: detail, type: "upstream_error", code: upstreamRes.status } })}\n\n`);
						write("data: [DONE]\n\n");
						return;
					}

					// Success: mark the chosen upstream in a comment frame
					// (ignored by parsers, visible in raw streams and logs).
					write(`: x-gw-provider ${target.provider.name} x-gw-model ${target.model}\n\n`);
					console.log(
						JSON.stringify({
							// "warn" per production-logging convention: recovered via failover.
							level: attempts.length > 0 ? "warn" : "info",
							requestId,
							model: requestedModel,
							provider: target.provider.name,
							upstreamModel: target.model,
							status: upstreamRes.status,
							stream: true,
							ms: Date.now() - startedAt,
							// Skipped-candidate history: makes failover causes auditable.
							...(attempts.length > 0 ? { attempts } : {}),
						}),
					);
					activeReader = upstreamRes.body.getReader();
				// Stream-end forensics: log exactly one terminal event per
				// stream so truncation incidents name the responsible layer
				// (upstream ended early / upstream broke / client stopped).
				let endLogged = false;
				let chunks = 0;
				let bytes = 0;
				let lastValue: Uint8Array | undefined;
				const tailDecoder = new TextDecoder();
				logStreamEnd = (reason: "upstream_done" | "upstream_error" | "client_cancel") => {
					if (endLogged) return;
					endLogged = true;
					const tail = lastValue === undefined ? "" : tailDecoder.decode(lastValue.slice(-64));
					console.log(
						JSON.stringify({
							level: reason === "upstream_done" ? "info" : "warn",
							event: "stream_end",
							reason,
							requestId,
							provider: target.provider.name,
							chunks,
							bytes,
							// Whether the upstream sent the SSE [DONE] sentinel.
							terminated: tail.includes("[DONE]"),
						}),
					);
				};
				try {
					for (;;) {
						const { done, value } = await activeReader.read();
						if (done) break;
						restartHeartbeat();
						chunks += 1;
						bytes += value.byteLength;
						lastValue = value;
						controller.enqueue(value);
					}
					const tail = lastValue === undefined ? "" : tailDecoder.decode(lastValue.slice(-64));
					if (!tail.includes("[DONE]")) {
						// Upstream closed without the SSE sentinel: the generation
						// was truncated server-side (e.g. relay killing long
						// streams). Emit OpenRouter's canonical mid-stream error
						// shape - top-level error PLUS a choices entry with
						// finish_reason:"error" - so parsers keyed on either
						// signal can surface it and retry, instead of silently
						// showing half an answer.
						write(`data: ${JSON.stringify({
							error: { message: "upstream ended the stream before completion (truncated); please retry", type: "upstream_truncated", code: "stream_truncated" },
							choices: [{ index: 0, delta: {}, finish_reason: "error" }],
						})}\n\n`);
						write("data: [DONE]\n\n");
						// Quarantine the truncating provider: this response is
						// unrecoverable, but the next requests must not walk
						// into the same relay-side cap.
						setCooldown(target.provider.name, TRUNCATION_COOLDOWN_S);
					}
					logStreamEnd("upstream_done");
				} catch {
					logStreamEnd("upstream_error");
				}
				return;
				}
				// All candidates failed after the SSE response was committed.
				console.log(JSON.stringify({ requestId, model: requestedModel, status: 502, stream: true, attempts }));
				write(`data: ${JSON.stringify({ error: { message: `all ${attempts.length} upstream attempts failed`, type: "cf_ai_gateway_error", code: "upstream_error", attempts } })}\n\n`);
				write("data: [DONE]\n\n");
			} finally {
				if (timer !== undefined) clearInterval(timer);
				try {
					controller.close();
				} catch {
					/* already closed */
				}
			}
		},
		cancel(reason) {
			logStreamEnd?.("client_cancel");
			void activeReader?.cancel(reason);
		},
	});
	return new Response(stream, { status: 200, headers });
}

function checkAuth(request: Request, env: Env): Response | null {
	const expected = env[GATEWAY_KEY_SECRET];
	if (expected === undefined || expected.length === 0) return null; // auth disabled
	const header = request.headers.get("authorization") ?? "";
	const token = header.startsWith("Bearer ") ? header.slice(7) : "";
	if (!timingSafeEqualStr(token, expected)) {
		// Rejections must be auditable: a silently-401ing client is the
		// classic "wrong key in one of several clients" forensic blind spot.
		console.log(JSON.stringify({ level: "warn", event: "auth_failed", method: request.method, path: safePath(request) }));
		return openAIError(401, "invalid_api_key", "missing or invalid gateway key");
	}
	return null;
}

function safePath(request: Request): string {
	try {
		return new URL(request.url).pathname;
	} catch {
		return "?";
	}
}

function timingSafeEqualStr(a: string, b: string): boolean {
	const encoder = new TextEncoder();
	const x = encoder.encode(a);
	const y = encoder.encode(b);
	let diff = x.length ^ y.length;
	const n = Math.max(x.length, y.length);
	for (let i = 0; i < n; i++) {
		diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
	}
	return diff === 0;
}

function upstreamContentType(res: Response): string {
	return res.headers.get("content-type") ?? "application/json";
}

function snippet(text: string): string {
	return text.length > ERROR_SNIPPET_BYTES ? `${text.slice(0, ERROR_SNIPPET_BYTES)}...` : text;
}

function json(payload: unknown, status: number): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json", ...CORS_HEADERS },
	});
}

function openAIError(
	status: number,
	code: string,
	message: string,
	attempts?: AttemptLog[],
	requestId?: string,
): Response {
	const response = json(
		{
			error: {
				message,
				type: "cf_ai_gateway_error",
				code,
				...(attempts === undefined ? {} : { attempts }),
			},
		},
		status,
	);
	if (requestId !== undefined) {
		const headers = new Headers(response.headers);
		headers.set("x-gw-request-id", requestId);
		return new Response(response.body, { status, headers });
	}
	return response;
}
