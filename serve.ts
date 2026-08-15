// Bun entrypoint: runs the same Worker code as a standalone HTTP server.
// The Worker handler signature (request, env) => Response maps 1:1 onto
// Bun.serve's fetch. Secrets come from the environment (systemd
// EnvironmentFile=/opt/cf-ai-gateway/.env).
import handler from "./src/index";

const port = Number(Bun.env.PORT ?? 567);

Bun.serve({
	port,
	// Bind IPv4 only: the origin is reached exclusively via Cloudflare's IPv4
	// origin-pull (DNS has no AAAA record), and an IPv6 wildcard listener would
	// be an unfiltered path past the IPv4-only firewall chain.
	hostname: "0.0.0.0",
	// Bun's default idleTimeout is 10s and silently kills SSE streams with
	// sparse bytes (oven-sh/bun#27479). The gateway's 2s heartbeat already
	// keeps every connection non-idle; 255 (Bun's maximum) adds defense in
	// depth for slow clients and long thinking phases.
	idleTimeout: 255,
	fetch(req) {
		return handler.fetch(req, Bun.env);
	},
	onError(err) {
		// Never let an exception kill the process; return OpenAI-style JSON.
		console.error(JSON.stringify({ fatal: String(err) }));
		return new Response(
			JSON.stringify({
				error: { message: "internal gateway error", type: "cf_ai_gateway_error", code: "internal" },
			}),
			{ status: 500, headers: { "content-type": "application/json" } },
		);
	},
});

console.log(`cf-ai-gateway (bun) listening on :${port}`);
