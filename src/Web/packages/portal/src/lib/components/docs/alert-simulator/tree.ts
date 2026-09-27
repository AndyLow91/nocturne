import { formatGlucoseValue, getUnitLabel, type GlucoseUnits } from "@nocturne/ui/glucose";
import type { ConditionNode, GroupNode, LeafKind, LeafNode } from "./engine";

export function isLeaf(node: ConditionNode): node is LeafNode {
	return node.type !== "composite" && node.type !== "not" && node.type !== "sustained";
}

/** In the engine's leaf-id order: pre-order, containers unwrapped (engine-semantics.md §2.2). */
export function leaves(node: ConditionNode): LeafNode[] {
	switch (node.type) {
		case "composite":
			return node.composite.conditions.flatMap(leaves);
		case "not":
			return leaves(node.not.child);
		case "sustained":
			return leaves(node.sustained.child);
		default:
			return [node];
	}
}

function glucose(mgdl: number, units: GlucoseUnits): string {
	return `${formatGlucoseValue(mgdl, units)} ${getUnitLabel(units)}`;
}

/** Rates are per minute; mmol/L to two places, since a 1 mg/dL/min rate is 0.06 mmol/L/min. */
export function rate(mgdlPerMinute: number, units: GlucoseUnits): string {
	return units === "mmol"
		? `${(mgdlPerMinute / 18.0182).toFixed(2)} mmol/L a minute`
		: `${mgdlPerMinute} mg/dL a minute`;
}

export function describeLeaf(node: LeafNode, units: GlucoseUnits): string {
	switch (node.type) {
		case "threshold":
			return `Glucose ${node.threshold.direction} ${glucose(node.threshold.value, units)}`;
		case "rate_of_change":
			return `${node.rate_of_change.direction === "falling" ? "Falling" : "Rising"} at least ${rate(node.rate_of_change.rate, units)}`;
		case "signal_loss":
			return `No reading for ${node.signal_loss.timeout_minutes} minutes`;
		case "time_of_day":
			return `Time is ${node.time_of_day.from} to ${node.time_of_day.to}`;
	}
}

/** Per leaf, in leaf-id order: whether a NOT inverts it, and the minutes a sustained holds it for. */
export function leafWrappers(
	node: ConditionNode,
	negated = false,
	minutes: number | null = null,
): { negated: boolean; minutes: number | null }[] {
	switch (node.type) {
		case "composite":
			return node.composite.conditions.flatMap((c) => leafWrappers(c, negated, minutes));
		case "not":
			return leafWrappers(node.not.child, !negated, minutes);
		case "sustained":
			return leafWrappers(node.sustained.child, negated, node.sustained.minutes);
		default:
			return [{ negated, minutes }];
	}
}

export const LEAF_KINDS: { kind: LeafKind; label: string }[] = [
	{ kind: "threshold", label: "Glucose" },
	{ kind: "rate_of_change", label: "Rate of change" },
	{ kind: "signal_loss", label: "Signal loss" },
	{ kind: "time_of_day", label: "Time of day" },
];

export function defaultLeaf(kind: LeafKind): LeafNode {
	switch (kind) {
		case "threshold":
			return { type: "threshold", threshold: { direction: "below", value: 70 } };
		case "rate_of_change":
			return { type: "rate_of_change", rate_of_change: { direction: "falling", rate: 3 } };
		case "signal_loss":
			return { type: "signal_loss", signal_loss: { timeout_minutes: 30 } };
		case "time_of_day":
			return { type: "time_of_day", time_of_day: { from: "22:00", to: "06:00" } };
	}
}

/** A row as the app's editor draws it: a condition, optionally NOT, optionally held for minutes. */
export interface Row {
	negated: boolean;
	minutes: number | null;
	leaf: LeafNode;
}

/** Null for a nested group, which is its own editor. Wrappers nest as not(sustained(leaf)). */
export function toRow(node: ConditionNode): Row | null {
	let negated = false;
	let minutes: number | null = null;
	let inner = node;
	if (inner.type === "not") {
		negated = true;
		inner = inner.not.child;
	}
	if (inner.type === "sustained") {
		minutes = inner.sustained.minutes;
		inner = inner.sustained.child;
	}
	return isLeaf(inner) ? { negated, minutes, leaf: inner } : null;
}

export function fromRow({ negated, minutes, leaf }: Row): ConditionNode {
	const held: ConditionNode = minutes === null ? leaf : { type: "sustained", sustained: { minutes, child: leaf } };
	return negated ? { type: "not", not: { child: held } } : held;
}

/** The editor always edits a group, as the app's does. */
export function asGroup(node: ConditionNode): GroupNode {
	return node.type === "composite"
		? node
		: { type: "composite", composite: { operator: "and", conditions: [node] } };
}

/** A one-condition group is saved as that condition, as the app saves it. */
export function collapse(node: ConditionNode): ConditionNode {
	return node.type === "composite" && node.composite.conditions.length === 1
		? node.composite.conditions[0]
		: node;
}
