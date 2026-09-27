import { base } from "$app/paths";

/**
 * A condition node in the engine's wire shape (docs/alerts/engine-semantics.md §1.2): the payload
 * sits under a property named after its `type`.
 */
export type ConditionNode =
	| { type: "composite"; composite: { operator: "and" | "or"; conditions: ConditionNode[] } }
	| { type: "not"; not: { child: ConditionNode } }
	| { type: "sustained"; sustained: { minutes: number; child: ConditionNode } }
	| { type: "threshold"; threshold: { direction: "above" | "below"; value: number } }
	| { type: "rate_of_change"; rate_of_change: { direction: "rising" | "falling"; rate: number } }
	| { type: "signal_loss"; signal_loss: { timeout_minutes: number } }
	| { type: "time_of_day"; time_of_day: { from: string; to: string } };

export type GroupNode = Extract<ConditionNode, { type: "composite" }>;
export type LeafNode = Exclude<ConditionNode, { type: "composite" | "not" | "sustained" }>;
export type LeafKind = LeafNode["type"];

export interface SimRule {
	id: string;
	name: string;
	condition: ConditionNode;
	autoResolve?: ConditionNode;
}

/** The replay context fields the demo's conditions read; everything else is left absent. */
export interface TickContext {
	latest_value?: number;
	latest_timestamp?: string;
	trend_rate?: number;
	last_reading_at?: string;
	tenant_time_zone_id: string;
}

export interface ReplayTick {
	at: string;
	context: TickContext;
}

export type ReplayEventKind = "fired" | "suppressed_by_dnd" | "auto_resolved" | "cleared";

export interface ReplayResult {
	order: string[];
	events: { at: string; rule_id: string; kind: ReplayEventKind }[];
	leaf_transitions: {
		rule_id: string;
		leaves: { leaf_id: number; points: { at_ms: number; value: boolean }[] }[];
	}[];
	ticks: {
		at: string;
		rules: ({ rule_id: string; met: boolean; firing: boolean } | { rule_id: string; skipped: true })[];
	}[];
}

export interface ValidationIssue {
	scope: string;
	path: string;
	reason: string;
	field?: string | null;
}

interface EngineModule {
	default: () => Promise<unknown>;
	replay(requestJson: string): string;
	validate(requestJson: string): string;
}

type Envelope<T> = ({ ok: true } & T) | { ok: false; error: string };

let loading: Promise<EngineModule> | undefined;

/**
 * Served from static/ rather than bundled (scripts/build-alerts-engine.mjs), so a portal built
 * without a Rust toolchain still typechecks and prerenders; only the demo is missing.
 */
export function loadEngine(): Promise<EngineModule> {
	loading ??= (async () => {
		const url = `${base}/alerts-engine/nocturne_alerts.js`;
		const engine: EngineModule = await import(/* @vite-ignore */ url);
		await engine.default();
		return engine;
	})();
	loading.catch(() => (loading = undefined));
	return loading;
}

function unwrap<T>(json: string): T {
	const envelope: Envelope<T> = JSON.parse(json);
	if (!envelope.ok) throw new Error(envelope.error);
	return envelope;
}

function payload(node: ConditionNode): unknown {
	switch (node.type) {
		case "composite":
			return node.composite;
		case "not":
			return node.not;
		case "sustained":
			return node.sustained;
		case "threshold":
			return node.threshold;
		case "rate_of_change":
			return node.rate_of_change;
		case "signal_loss":
			return node.signal_loss;
		case "time_of_day":
			return node.time_of_day;
	}
}

/** The root node's payload is the rule's `condition_params`, as the API stores a rule. */
function wireRule(rule: SimRule) {
	return {
		id: rule.id,
		condition_type: rule.condition.type,
		condition_params: payload(rule.condition),
		auto_resolve_enabled: rule.autoResolve !== undefined,
		auto_resolve_params: rule.autoResolve ?? null,
	};
}

export async function replay(rules: SimRule[], ticks: ReplayTick[]): Promise<ReplayResult> {
	const engine = await loadEngine();
	return unwrap<ReplayResult>(
		engine.replay(
			JSON.stringify({ schema_version: 1, rules: rules.map(wireRule), ticks, include_ticks: true }),
		),
	);
}

/** The save-time check the API runs, so the demo refuses exactly what a save would. */
export async function validate(rule: SimRule): Promise<ValidationIssue[]> {
	const engine = await loadEngine();
	const { condition_type, condition_params, auto_resolve_params } = wireRule(rule);
	return unwrap<{ issues: ValidationIssue[] }>(
		engine.validate(
			JSON.stringify({ schema_version: 1, condition_type, condition_params, auto_resolve_params }),
		),
	).issues;
}
