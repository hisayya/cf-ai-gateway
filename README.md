# cf-ai-gateway

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare%20Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)
![Bun](https://img.shields.io/badge/Bun-F9F1E1?style=flat-square&logo=bun&logoColor=black)
![GitHub stars](https://img.shields.io/github/stars/hisayya/cf-ai-gateway?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)


> **OpenAI-compatible, multi-provider AI gateway running on Cloudflare Workers.**
> One endpoint, many upstreams — with weighted load balancing, automatic failover, and streaming-friendly SSE keep-alive.

`cf-ai-gateway` exposes a **single OpenAI-compatible endpoint** (`/v1/chat/completions`) in front of **multiple upstream LLM providers**. Clients talk to it exactly like they talk to OpenAI; the gateway handles model routing, weighted load balancing, failover on rate-limits / auth / 5xx / context-overflow, and zero-buffer SSE streaming for chat.

Built for a **zero-ops, pay-as-you-go edge**: it runs entirely on Cloudflare Workers, so there is no server to manage and you only pay for actual usage.

---

## ✨ Features

- **One API, many providers** — route by model alias (e.g. `north-mini-code`) or direct `provider/model` form.
- **Weighted load balancing** — same-priority upstreams are balanced by configurable weights; different priorities are tried in order.
- **Automatic failover** — walks the candidate list on 429 / 5xx / auth errors / context-overflow, and forwards the first working upstream.
- **Per-provider circuit breaker (cooldown)** — a 429/401 parks a provider for a configurable window instead of hammering it.
- **Streaming with heartbeat** — returns SSE from *t=0* and injects `: keep-alive` comments every 2s, so silently-buffering upstreams never trip client read timeouts.
- **CORS + `Bearer` auth** (opt-in via a Worker Secret), request-body caps, robust error classification.
- **Zero buffer** — streams pass through verbatim; JSON pass-through is fully validated for OpenRouter's "200 + embedded error" envelope.

---

## 🧱 Architecture

```
┌────────────┐   single OpenAI-compatible API
│   Client   │  /v1/chat/completions  (stream=yes/no)
└─────┬──────┘
      │  Bearer <gateway-key>  (optional)
┌─────▼──────────────────────────────────────────────┐
│                 cf-ai-gateway (Worker)              │
│                                                     │
│   resolveCandidates(alias)                          │
│        │  weighted LB within tier                   │
│        ▼                                             │
│   ┌─────────────┐   failover / cooldown             │
│   │  Upstream 1 │──► 200/SSE  → pass through        │
│   │  Upstream 2 │──► 429 → cooldown → next          │
│   │  Upstream 3 │──► 5xx/context-overflow → next    │
│   └─────────────┘                                   │
└───────────────┬──────────────────────────────────────┘
                │
        Cloudflare Workers (zero-ops, serverless)
```

**How a request flows:** client → (optional auth) → model resolution → weighted candidate ordering → try upstreams in order with per-provider cooldowns → on success, **stream chunks / JSON verbatim** back to the client with `x-gw-provider` / `x-gw-model` / `x-gw-request-id` headers.

---

## 🚀 Getting started

### 1. Deploy

```bash
# install
bun install

# local dev
bun run dev          # wrangler dev

# deploy to Cloudflare Workers
bun run deploy       # wrangler deploy
```

### 2. Set upstream provider keys (as Worker Secrets, never in source)

```bash
wrangler secret put ARK_API_KEY
wrangler secret put OPENAI_API_KEY
# ... one per provider defined in src/config.ts
```

### 3. Configure providers & routes in `src/config.ts`

```ts
// One entry per upstream provider
export const PROVIDERS: ProviderConfig[] = [
  { name: "ark",     baseUrl: "https://ark.cn-beijing.volces.com/api/v3", keySecret: "ARK_API_KEY" },
  { name: "openai",  baseUrl: "https://api.openai.com/v1",               keySecret: "OPENAI_API_KEY" },
];

// Map public aliases to ordered candidate lists
export const MODEL_ROUTES: ModelRoute[] = [
  { alias: "fast", targets: [
      { provider: "ark", model: "ep-xxx", weight: 3, priority: 0 },
      { provider: "openai", model: "gpt-4o-mini", weight: 1, priority: 0 },
  ]},
];
```

### 4. Use it (OpenAI-compatible)

```bash
curl https://<your-worker>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer <gateway-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "fast",
    "messages": [{"role":"user","content":"Hello"}],
    "stream": true
  }'
```

---

## 📦 Tech stack

- **Cloudflare Workers** — serverless edge runtime
- **TypeScript / wrangler 4** — typed, zero-ops deployment
- **Bun** — fast dev/test toolchain (uses `bun test`)

---

## 📂 Project layout

```
src/
  index.ts    # Worker entry: routing, failover, SSE stream pump
  config.ts   # providers + model routing table (edit here)
  router.ts   # alias resolution, weighted LB, per-provider cooldown
  upstream.ts # upstream HTTP calls, status classification, retry-after
tests/
  unit.test.ts
wrangler.jsonc # Workers config
```

---

## 📄 License

MIT — free to use, modify, and deploy.
