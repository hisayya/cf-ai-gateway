// Gateway configuration: upstream providers and model routing table.
// All API keys are stored as Worker Secrets (never in source code).
// To add a key: `wrangler secret put <keySecret name>`.

export interface ProviderConfig {
	// Short unique id used in routing targets and in the "provider/model" direct form.
	name: string;
	// Base URL of the OpenAI-compatible endpoint WITHOUT trailing slash.
	// Include the version prefix the provider expects, e.g. "https://api.deepseek.com/v1".
	baseUrl: string;
	// Name of the Worker Secret holding this provider's API key.
	keySecret: string;
	// Timeout for upstream response headers (ms). Default 30000.
	timeoutMs?: number;
}

export interface RouteTarget {
	// Must match a ProviderConfig.name.
	provider: string;
	// Model name sent to the upstream provider.
	model: string;
	// Selection weight within the same priority tier. Default 1.
	weight?: number;
	// Lower = tried first. Default 0. Same-tier targets are load balanced by weight.
	priority?: number;
}

export interface ModelRoute {
	// Public model name clients send in the "model" field.
	alias: string;
	// Ordered candidate list; failover walks this list on retryable errors.
	targets: RouteTarget[];
}

// ---------------------------------------------------------------------------
// Upstream providers
// ---------------------------------------------------------------------------
export const PROVIDERS: ProviderConfig[] = [
	{
		name: "ark-plan",
		baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
		keySecret: "KEY_ARK_PLAN",
	},
	{
		name: "ark-coding",
		baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
		keySecret: "KEY_ARK_CODING",
	},
	{
		name: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		keySecret: "KEY_OPENROUTER",
	},
	{
		name: "lfree",
		baseUrl: "https://ai.lfree.org/v1",
		keySecret: "KEY_LFREE",
	},
];

// ---------------------------------------------------------------------------
// Model routing table.
// Single public alias "auto": sticky primary (tier 0) -> equal-weight pool
// (tier 1) -> reliable floor (tier 2, tried last).
// ---------------------------------------------------------------------------
export const MODEL_ROUTES: ModelRoute[] = [
	{
		alias: "auto",
		targets: [
			// Tier 0: default target, used for all traffic unless unavailable.
			// NOTE: lfree buffers its whole thinking phase server-side and sends
			// zero bytes for ~8s+ (longer on big prompts); the gateway injects
			// SSE keep-alive comments during that silence so client read
			// timeouts never fire (see SSE_HEARTBEAT_MS in index.ts).
			{ provider: "lfree", model: "deepseek-v4-flash", priority: 0 },
			// Tier 1: equal weight across ark-plan / ark-coding models.
			{ provider: "ark-plan", model: "deepseek-v4-flash", priority: 1 },
			{ provider: "ark-coding", model: "deepseek-v4-flash", priority: 1 },
			{ provider: "ark-plan", model: "glm-5.3", priority: 1 },
			{ provider: "ark-coding", model: "glm-5.3", priority: 1 },
			{ provider: "ark-plan", model: "deepseek-v4-pro", priority: 1 },
			{ provider: "ark-coding", model: "deepseek-v4-pro", priority: 1 },
			// Tier 2: last-resort floor, only when everything above failed.
			{ provider: "openrouter", model: "nvidia/nemotron-3-ultra-550b-a55b:free", priority: 2 },
		],
	},
];

// Gateway auth: clients must send `Authorization: Bearer <GATEWAY_KEY>`.
// Stored via `wrangler secret put GATEWAY_KEY`. Leave unset to disable auth.
export const GATEWAY_KEY_SECRET = "GATEWAY_KEY";

// How long a provider is skipped after a rate limit (seconds), unless the
// upstream sends a Retry-After header.
export const RATE_LIMIT_COOLDOWN_S = 60;
// How long a provider is skipped after auth errors (seconds): key likely dead.
export const AUTH_ERROR_COOLDOWN_S = 600;
// Default upstream header timeout (ms). Large-context requests (hundreds of
// K tokens) can take over 30s before the first byte even on success, so keep
// this generous; the client enforces its own end-to-end timeout.
export const DEFAULT_TIMEOUT_MS = 120_000;
