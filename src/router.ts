// Model resolution, weighted load balancing and per-provider cooldown state.
// Cooldown state lives per isolate (Workers spawn many isolates); it is a
// best-effort local circuit breaker, exact cross-isolate state would need KV/DO.

import { PROVIDERS, MODEL_ROUTES } from "./config";
import type { ProviderConfig, RouteTarget } from "./config";

export interface ResolvedTarget {
	provider: ProviderConfig;
	model: string;
}

const providerIndex = new Map<string, ProviderConfig>(PROVIDERS.map((p) => [p.name, p]));
const routeIndex = new Map<string, RouteTarget[]>(MODEL_ROUTES.map((r) => [r.alias, r.targets]));

// provider name -> cooldown expiry (ms epoch)
const cooldownUntil = new Map<string, number>();

export function setCooldown(provider: string, seconds: number): void {
	const clamped = Math.min(Math.max(seconds, 1), 3600);
	cooldownUntil.set(provider, Date.now() + clamped * 1000);
}

export function inCooldown(provider: string): boolean {
	const until = cooldownUntil.get(provider);
	if (until === undefined) return false;
	if (until <= Date.now()) {
		cooldownUntil.delete(provider);
		return false;
	}
	return true;
}

export function cooldownRemainingS(provider: string): number {
	const until = cooldownUntil.get(provider);
	if (until === undefined) return 0;
	return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

/** True when the model is a known route alias or a valid "provider/model" form. */
export function routeExists(model: string): boolean {
	if (routeIndex.has(model)) return true;
	const slash = model.indexOf("/");
	if (slash > 0) {
		const provider = providerIndex.get(model.slice(0, slash));
		return provider !== undefined && model.slice(slash + 1).length > 0;
	}
	return false;
}

/**
 * Resolve a requested model name into an ordered candidate list.
 * Two forms are supported:
 *  1. Route alias (e.g. "fast") -> load-balanced failover chain.
 *  2. Direct form "provider/model" (e.g. "deepseek/deepseek-chat") -> single target.
 * Providers currently in cooldown are dropped; returns null when no usable
 * target remains.
 */
export function resolveCandidates(requestedModel: string): ResolvedTarget[] | null {
	// Direct "provider/model" form takes precedence over aliases.
	const slash = requestedModel.indexOf("/");
	if (slash > 0) {
		const provider = providerIndex.get(requestedModel.slice(0, slash));
		const model = requestedModel.slice(slash + 1);
		if (provider !== undefined && model.length > 0) {
			return [{ provider, model }];
		}
	}

	const targets = routeIndex.get(requestedModel);
	if (targets === undefined) return null;

	const ordered: ResolvedTarget[] = [];
	for (const t of orderTargets(targets)) {
		if (inCooldown(t.provider)) continue;
		const provider = providerIndex.get(t.provider);
		if (provider !== undefined) ordered.push({ provider, model: t.model });
	}
	return ordered.length > 0 ? ordered : null;
}

/**
 * Order route targets for one request:
 *  - priority tiers ascending (lower = preferred),
 *  - inside a tier the primary is picked by weighted random (stateless LB),
 *    remaining tier members follow by weight desc as failover order.
 */
function orderTargets(targets: RouteTarget[]): RouteTarget[] {
	const tiers = new Map<number, RouteTarget[]>();
	for (const t of targets) {
		const p = t.priority ?? 0;
		const bucket = tiers.get(p);
		if (bucket) bucket.push(t);
		else tiers.set(p, [t]);
	}

	const result: RouteTarget[] = [];
	for (const p of [...tiers.keys()].sort((a, b) => a - b)) {
		const bucket = tiers.get(p)!;
		const winner = pickWeighted(bucket);
		result.push(winner);
		for (const t of restByWeight(bucket)) {
			if (t !== winner) result.push(t);
		}
	}
	return result;
}

function pickWeighted(bucket: RouteTarget[]): RouteTarget {
	const weights = bucket.map((t) => t.weight ?? 1);
	const total = weights.reduce((a, b) => a + b, 0);
	let roll = Math.random() * total;
	for (let i = 0; i < bucket.length; i++) {
		roll -= weights[i]!;
		if (roll <= 0) return bucket[i]!;
	}
	return bucket[bucket.length - 1]!;
}

function restByWeight(bucket: RouteTarget[]): RouteTarget[] {
	// Stable sort by weight desc, preserving config order for equal weights.
	return bucket
		.map((t, i) => ({ t, i }))
		.sort((a, b) => (b.t.weight ?? 1) - (a.t.weight ?? 1) || a.i - b.i)
		.map(({ t }) => t);
}
