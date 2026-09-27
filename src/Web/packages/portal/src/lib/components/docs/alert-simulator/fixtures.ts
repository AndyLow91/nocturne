import type { ReplayTick } from "./engine";

/** Every reading is synthetic: shaped to show one behaviour, not taken from anyone's data. */
export interface Reading {
	at: number;
	mgdl: number;
	/** mg/dL per minute, as a CGM reports it with the reading. */
	trendRate: number;
}

export interface Scenario {
	id: ScenarioId;
	label: string;
	description: string;
	start: number;
	end: number;
	readings: Reading[];
}

export type ScenarioId =
	| "overnight-low"
	| "brief-dip"
	| "fast-fall"
	| "sensor-gap"
	| "meal-high"
	| "high-dip-high";

const MINUTE = 60_000;
const STEP = 5 * MINUTE;
/** A Monday, so a day-of-week reading of the trace is unsurprising. Times are shown as UTC. */
const DAY = Date.UTC(2026, 0, 5);

/** `HH:mm` on the fixture day; hours past 23 run into the next day. */
function at(hhmm: string): number {
	const [h, m] = hhmm.split(":").map(Number);
	return DAY + (h * 60 + m) * MINUTE;
}

/**
 * Readings every 5 minutes along straight lines between `points`, with a small fixed wobble so
 * the trace reads as a sensor rather than a ruler. Readings inside a `gaps` span are dropped.
 */
function trace(
	points: [string, number][],
	gaps: [string, string][] = [],
	wobble = 1.5,
): Reading[] {
	const keys = points.map(([t, v]) => [at(t), v] as const);
	const holes = gaps.map(([from, to]) => [at(from), at(to)] as const);
	const values: { at: number; mgdl: number }[] = [];
	for (let t = keys[0][0]; t <= keys[keys.length - 1][0]; t += STEP) {
		const i = keys.findIndex(([k], j) => j < keys.length - 1 && t >= k && t <= keys[j + 1][0]);
		const [t0, v0] = keys[i];
		const [t1, v1] = keys[i + 1];
		const linear = v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
		const step = (t - keys[0][0]) / STEP;
		values.push({ at: t, mgdl: Math.round(linear + wobble * Math.sin(step * 1.7)) });
	}
	return values
		.map((r, i) => {
			const neighbour = values[i - 1] ?? values[i + 1];
			const delta = i === 0 ? neighbour.mgdl - r.mgdl : r.mgdl - neighbour.mgdl;
			return { ...r, trendRate: Math.round((delta / 5) * 10) / 10 };
		})
		.filter((r) => !holes.some(([from, to]) => r.at > from && r.at < to));
}

export const SCENARIOS: Record<ScenarioId, Scenario> = {
	"overnight-low": {
		id: "overnight-low",
		label: "Overnight low",
		description: "A slow drift down after midnight that stays low for most of an hour.",
		start: at("23:00"),
		end: at("27:00"),
		readings: trace([
			["23:00", 124],
			["23:40", 112],
			["24:40", 72],
			["25:10", 59],
			["25:30", 60],
			["25:55", 69],
			["26:15", 84],
			["27:00", 98],
		]),
	},
	"brief-dip": {
		id: "brief-dip",
		label: "Brief dip",
		description: "Steady in the 80s, with three readings just under 70 in the middle of the afternoon.",
		start: at("13:00"),
		end: at("16:00"),
		readings: trace(
			[
				["13:00", 88],
				["13:50", 82],
				["14:00", 76],
				["14:05", 68],
				["14:15", 67],
				["14:20", 74],
				["14:35", 84],
				["16:00", 86],
			],
			[],
			1,
		),
	},
	"fast-fall": {
		id: "fast-fall",
		label: "Fast fall",
		description: "Steady at 150, then a fall of about 3 mg/dL a minute during exercise.",
		start: at("16:00"),
		end: at("18:30"),
		readings: trace(
			[
				["16:00", 150],
				["16:45", 152],
				["17:20", 66],
				["17:35", 61],
				["17:55", 74],
				["18:30", 104],
			],
			[],
			0.8,
		),
	},
	"sensor-gap": {
		id: "sensor-gap",
		label: "Sensor gap",
		description: "Readings stop for 40 minutes, as when the phone and the sensor lose touch.",
		start: at("02:00"),
		end: at("05:00"),
		readings: trace(
			[
				["02:00", 112],
				["03:00", 104],
				["03:40", 98],
				["05:00", 108],
			],
			[["03:00", "03:40"]],
		),
	},
	"meal-high": {
		id: "meal-high",
		label: "High after a meal",
		description: "A rise to the high 200s after dinner that starts coming down while still over 250.",
		start: at("18:00"),
		end: at("23:00"),
		readings: trace(
			[
				["18:00", 112],
				["18:30", 120],
				["19:30", 284],
				["19:55", 282],
				["20:40", 228],
				["21:30", 176],
				["22:00", 158],
				["23:00", 140],
			],
			[],
			0.6,
		),
	},
	"high-dip-high": {
		id: "high-dip-high",
		label: "High, dip, high",
		description: "Going high 20 minutes before 18:00, back down through the evening, then high again just before 20:00.",
		start: at("17:00"),
		end: at("21:00"),
		readings: trace(
			[
				["17:00", 150],
				["17:35", 176],
				["17:45", 190],
				["17:55", 196],
				["18:25", 150],
				["19:35", 140],
				["19:50", 192],
				["21:00", 214],
			],
			[],
			0.6,
		),
	},
};

function iso(ms: number): string {
	return new Date(ms).toISOString().replace(".000Z", "Z");
}

/**
 * The context each 5-minute tick is evaluated against, built as the API's replay does
 * (AlertReplayService): the newest reading at or before the tick, however old, and a tick before
 * the first reading reading as fresh rather than as no reading ever.
 */
export function ticksFor(scenario: Scenario): ReplayTick[] {
	const ticks: ReplayTick[] = [];
	let next = 0;
	let current: Reading | undefined;
	for (let t = scenario.start; t < scenario.end; t += STEP) {
		while (next < scenario.readings.length && scenario.readings[next].at <= t) {
			current = scenario.readings[next++];
		}
		ticks.push({
			at: iso(t),
			context: current
				? {
						latest_value: current.mgdl,
						latest_timestamp: iso(current.at),
						trend_rate: current.trendRate,
						last_reading_at: iso(current.at),
						tenant_time_zone_id: "UTC",
					}
				: { last_reading_at: iso(t), tenant_time_zone_id: "UTC" },
		});
	}
	return ticks;
}
