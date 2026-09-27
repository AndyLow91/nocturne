import type { ConditionNode, SimRule } from "./engine";

const below = (value: number): ConditionNode => ({ type: "threshold", threshold: { direction: "below", value } });
const above = (value: number): ConditionNode => ({ type: "threshold", threshold: { direction: "above", value } });
const falling = (rate: number): ConditionNode => ({ type: "rate_of_change", rate_of_change: { direction: "falling", rate } });
const sustained = (minutes: number, child: ConditionNode): ConditionNode => ({ type: "sustained", sustained: { minutes, child } });
const all = (...conditions: ConditionNode[]): ConditionNode => ({ type: "composite", composite: { operator: "and", conditions } });
const any = (...conditions: ConditionNode[]): ConditionNode => ({ type: "composite", composite: { operator: "or", conditions } });
const not = (child: ConditionNode): ConditionNode => ({ type: "not", not: { child } });
const between = (from: string, to: string): ConditionNode => ({ type: "time_of_day", time_of_day: { from, to } });

/** The example rules the docs pages load into the simulator, by id. Values are mg/dL. */
export const PRESETS = {
	"low": { name: "Low", condition: below(70) },
	"sustained-low": { name: "Low for 15 minutes", condition: sustained(15, below(70)) },
	"falling-and-low": { name: "Falling toward low", condition: all(below(100), falling(2)) },
	"low-or-falling": { name: "Low, or falling toward it", condition: any(below(70), all(below(100), falling(2))) },
	"falling-any": { name: "Under 100 or falling", condition: any(below(100), falling(2)) },
	"signal-loss": { name: "Signal loss", condition: { type: "signal_loss", signal_loss: { timeout_minutes: 20 } } },
	"high": { name: "High", condition: above(250) },
	"high-auto-resolve": {
		name: "High, until it is coming down",
		condition: above(250),
		autoResolve: sustained(15, falling(1)),
	},
	"high-after-dinner-timer-first": {
		name: "Sustained high first",
		condition: all(sustained(30, above(180)), not(between("18:00", "20:00"))),
	},
	"high-after-dinner-gate-first": {
		name: "Time window first",
		condition: all(not(between("18:00", "20:00")), sustained(30, above(180))),
	},
} satisfies Record<string, Omit<SimRule, "id">>;

export type PresetId = keyof typeof PRESETS;

export function presetRule(id: PresetId, index: number): SimRule {
	const preset: Omit<SimRule, "id"> = PRESETS[id];
	return {
		id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
		...structuredClone(preset),
	};
}
