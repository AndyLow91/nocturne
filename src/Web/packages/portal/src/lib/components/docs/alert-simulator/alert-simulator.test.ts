import { describe, expect, it } from 'vitest';
import type { ConditionNode } from './engine';
import { SCENARIOS, ticksFor, type Scenario } from './fixtures';
import { PRESETS } from './presets';
import { asGroup, collapse, fromRow, leafWrappers, leaves, toRow } from './tree';

const MINUTE = 60_000;

function scenario(readings: [number, number][]): Scenario {
	return {
		id: 'brief-dip',
		label: '',
		description: '',
		start: 0,
		end: 30 * MINUTE,
		readings: readings.map(([m, mgdl]) => ({ at: m * MINUTE, mgdl, trendRate: 0 })),
	};
}

describe('ticksFor', () => {
	it('reads each tick against the newest reading at or before it, however old', () => {
		const ticks = ticksFor(scenario([[5, 100], [10, 90]]));
		expect(ticks.map((t) => t.context.latest_value)).toEqual([undefined, 100, 90, 90, 90, 90]);
		expect(ticks[4].context.last_reading_at).toBe('1970-01-01T00:10:00Z');
	});

	it('reads a tick before the first reading as fresh, not as no reading ever', () => {
		const [first] = ticksFor(scenario([[5, 100]]));
		expect(first.context.last_reading_at).toBe(first.at);
		expect(first.context.latest_timestamp).toBeUndefined();
	});
});

describe('fixtures the docs describe', () => {
	const below70 = (id: keyof typeof SCENARIOS) => SCENARIOS[id].readings.filter((r) => r.mgdl < 70).length;

	it('keeps the brief dip to three readings under 70, ten minutes', () => {
		expect(below70('brief-dip')).toBe(3);
	});

	it('stops readings for the whole of the sensor gap', () => {
		const inGap = SCENARIOS['sensor-gap'].readings.filter(
			(r) => r.at > Date.UTC(2026, 0, 5, 3, 0) && r.at < Date.UTC(2026, 0, 5, 3, 40),
		);
		expect(inGap).toEqual([]);
	});

	it('reads every scenario every 5 minutes, in order', () => {
		for (const s of Object.values(SCENARIOS)) {
			expect(s.readings.every((r, i) => i === 0 || r.at > s.readings[i - 1].at)).toBe(true);
			expect(s.readings.every((r) => (r.at - s.start) % (5 * MINUTE) === 0)).toBe(true);
		}
	});
});

describe('tree', () => {
	const below = (value: number): ConditionNode => ({ type: 'threshold', threshold: { direction: 'below', value } });
	const tree: ConditionNode = {
		type: 'composite',
		composite: {
			operator: 'or',
			conditions: [
				{ type: 'not', not: { child: { type: 'sustained', sustained: { minutes: 15, child: below(70) } } } },
				{ type: 'composite', composite: { operator: 'and', conditions: [below(100), below(90)] } },
			],
		},
	};

	it('numbers leaves in pre-order with containers unwrapped, as the engine does', () => {
		expect(leaves(tree).map((l) => (l.type === 'threshold' ? l.threshold.value : null))).toEqual([70, 100, 90]);
		expect(leafWrappers(tree)).toEqual([
			{ negated: true, minutes: 15 },
			{ negated: false, minutes: null },
			{ negated: false, minutes: null },
		]);
	});

	it('round-trips a wrapped row in the order the app nests it', () => {
		const [first] = tree.type === 'composite' ? tree.composite.conditions : [];
		const row = toRow(first);
		expect(row).toMatchObject({ negated: true, minutes: 15 });
		expect(row && fromRow(row)).toEqual(first);
	});

	it('edits a bare condition as a group and saves a one-row group as the row', () => {
		const group = asGroup(below(70));
		expect(group.composite.conditions).toHaveLength(1);
		expect(collapse(group)).toEqual(below(70));
	});

	it('gives every preset a tree the editor can show row by row', () => {
		for (const preset of Object.values(PRESETS)) {
			const group = asGroup(preset.condition);
			for (const child of group.composite.conditions) {
				if (child.type !== 'composite') expect(toRow(child)).not.toBeNull();
			}
		}
	});
});
