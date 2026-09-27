<script lang="ts">
    import { untrack } from "svelte";
    import Bell from "@lucide/svelte/icons/bell";
    import BellOff from "@lucide/svelte/icons/bell-off";
    import Cpu from "@lucide/svelte/icons/cpu";
    import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
    import { Button } from "@nocturne/ui/ui/button";
    import * as ToggleGroup from "@nocturne/ui/ui/toggle-group";
    import { convertToDisplayUnits, formatGlucoseValue, getUnitLabel } from "@nocturne/ui/glucose";
    import { glucoseUnits } from "@nocturne/app/stores/appearance-store.svelte";
    import { replay, validate, type GroupNode, type ReplayResult, type SimRule, type ValidationIssue } from "./engine";
    import { SCENARIOS, ticksFor, type ScenarioId } from "./fixtures";
    import { presetRule, type PresetId } from "./presets";
    import { asGroup, collapse, describeLeaf, isLeaf, leafWrappers, leaves, rate } from "./tree";
    import ConditionEditor from "./ConditionEditor.svelte";

    interface Props {
        /** The trace shown first. */
        scenario: ScenarioId;
        /** Offered as tabs when there is more than one; defaults to just `scenario`. */
        scenarios?: ScenarioId[];
        /** Replayed side by side over the same trace, so a reader can compare them. */
        rules: PresetId[];
        editable?: boolean;
    }

    let { scenario, scenarios, rules, editable = false }: Props = $props();

    const RULE_COLOURS = ["var(--chart-3)", "var(--chart-1)", "var(--chart-2)"];
    const PAD_LEFT = 44;
    const PAD_RIGHT = 12;
    const CHART_HEIGHT = 180;
    const CHART_TOP = 10;
    const CHART_BOTTOM = 22;

    /** The editor edits a group, as the app's does; `collapse` turns it back into the saved shape. */
    type EditingRule = SimRule & { condition: GroupNode };

    function initialRules(): EditingRule[] {
        return rules.map((id, index) => {
            const rule = presetRule(id, index);
            return { ...rule, condition: asGroup(rule.condition) };
        });
    }

    let scenarioId = $state(untrack(() => scenario));
    let editing = $state(untrack(initialRules));
    let result = $state<ReplayResult>();
    let issues = $state<ValidationIssue[][]>([]);
    let failure = $state<string>();
    let width = $state(0);
    let hover = $state<number>();

    const units = $derived(glucoseUnits.current);
    const active = $derived(SCENARIOS[scenarioId]);
    const offered = $derived((scenarios ?? [scenario]).map((id) => SCENARIOS[id]));
    const ticks = $derived(ticksFor(active));

    $effect(() => {
        const sent = $state.snapshot(editing).map((r) => ({ ...r, condition: collapse(r.condition) }));
        const sentTicks = ticks;
        let cancelled = false;
        const timer = setTimeout(async () => {
            try {
                const found = await Promise.all(sent.map(validate));
                if (cancelled) return;
                issues = found;
                failure = undefined;
                if (found.some((f) => f.length > 0)) return;
                const replayed = await replay(sent, sentTicks);
                if (!cancelled) result = replayed;
            } catch (error) {
                if (!cancelled) failure = error instanceof Error ? error.message : String(error);
            }
        }, 120);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    });

    const plotWidth = $derived(Math.max(0, width - PAD_LEFT - PAD_RIGHT));
    const x = (ms: number) => PAD_LEFT + ((ms - active.start) / (active.end - active.start)) * plotWidth;
    const tickMs = $derived(ticks.map((t) => Date.parse(t.at)));
    const stepWidth = $derived(tickMs.length > 1 ? x(tickMs[1]) - x(tickMs[0]) : 0);

    const yMax = $derived(Math.max(220, Math.ceil((Math.max(...active.readings.map((r) => r.mgdl)) + 20) / 20) * 20));
    const Y_MIN = 40;
    const y = (mgdl: number) =>
        CHART_TOP + (1 - (mgdl - Y_MIN) / (yMax - Y_MIN)) * (CHART_HEIGHT - CHART_TOP - CHART_BOTTOM);

    function rangeColour(mgdl: number): string {
        if (mgdl < 54) return "var(--glucose-very-low)";
        if (mgdl < 70) return "var(--glucose-low)";
        if (mgdl > 250) return "var(--glucose-very-high)";
        if (mgdl > 180) return "var(--glucose-high)";
        return "var(--glucose-in-range)";
    }

    function clock(ms: number): string {
        return new Date(ms).toISOString().slice(11, 16);
    }

    const hourMarks = $derived.by(() => {
        const marks: number[] = [];
        const hour = 3_600_000;
        for (let t = Math.ceil(active.start / hour) * hour; t <= active.end; t += hour) marks.push(t);
        return marks;
    });

    /** Consecutive readings joined; a gap longer than one missed reading breaks the line. */
    const segments = $derived.by(() => {
        const lines: string[] = [];
        let current: string[] = [];
        active.readings.forEach((r, i) => {
            const previous = active.readings[i - 1];
            if (previous && r.at - previous.at > 7 * 60_000) {
                lines.push(current.join(" "));
                current = [];
            }
            current.push(`${x(r.at)},${y(r.mgdl)}`);
        });
        lines.push(current.join(" "));
        return lines;
    });

    /** Runs of true ticks as [start, end) in ms, the end one tick past the last true tick. */
    function runs(values: boolean[]): [number, number][] {
        const out: [number, number][] = [];
        let from: number | undefined;
        values.forEach((v, i) => {
            if (v && from === undefined) from = tickMs[i];
            if (!v && from !== undefined) {
                out.push([from, tickMs[i]]);
                from = undefined;
            }
        });
        if (from !== undefined) out.push([from, active.end]);
        return out;
    }

    interface Lane {
        label: string;
        runs: [number, number][];
    }

    interface RuleView {
        rule: EditingRule;
        colour: string;
        conditionLanes: Lane[];
        /** A rule that is one bare condition is true exactly when its condition is. */
        showsWhole: boolean;
        met: [number, number][];
        firing: [number, number][];
        events: { at: number; kind: string }[];
        metAt: boolean[];
        firingAt: boolean[];
    }

    const views = $derived.by((): RuleView[] => {
        if (!result) return [];
        const replayed = result;
        return editing.map((rule, index) => {
            const tree = collapse(rule.condition);
            const log = replayed.leaf_transitions.find((l) => l.rule_id === rule.id);
            const wrappers = leafWrappers(tree);
            const conditionLanes = leaves(tree).map((leaf, leafId) => {
                const points = log?.leaves.find((l) => l.leaf_id === leafId)?.points ?? [];
                const values = tickMs.map((t) => {
                    let value = false;
                    for (const p of points) if (p.at_ms <= t) value = p.value;
                    return value;
                });
                const { negated, minutes } = wrappers[leafId];
                const label = [
                    negated ? "NOT applies to: " : "",
                    describeLeaf(leaf, units),
                    minutes === null ? "" : `, must hold ${minutes} min`,
                ].join("");
                return { label, runs: runs(values) };
            });
            const states = replayed.ticks.map((t) => t.rules.find((r) => r.rule_id === rule.id));
            const metAt = states.map((s) => (s && "met" in s ? s.met : false));
            const firingAt = states.map((s) => (s && "firing" in s ? s.firing : false));
            return {
                rule,
                colour: RULE_COLOURS[index % RULE_COLOURS.length],
                conditionLanes,
                showsWhole: !isLeaf(tree),
                met: runs(metAt),
                firing: runs(firingAt),
                events: replayed.events
                    .filter((e) => e.rule_id === rule.id)
                    .map((e) => ({ at: Date.parse(e.at), kind: e.kind })),
                metAt,
                firingAt,
            };
        });
    });

    function story(view: RuleView): string {
        if (view.events.length === 0) return "No alert over this trace.";
        return view.events
            .map((e) => {
                if (e.kind === "fired") return `alerts at ${clock(e.at)}`;
                if (e.kind === "cleared") return `stops at ${clock(e.at)}`;
                if (e.kind === "auto_resolved") return `auto-resolves at ${clock(e.at)}`;
                return `silenced by Do Not Disturb at ${clock(e.at)}`;
            })
            .join(", ")
            .replace(/^./, (c) => c.toUpperCase())
            .concat(".");
    }

    function onpointermove(event: PointerEvent & { currentTarget: HTMLElement }): void {
        const box = event.currentTarget.getBoundingClientRect();
        const px = event.clientX - box.left;
        if (px < PAD_LEFT || px > width - PAD_RIGHT || stepWidth === 0) {
            hover = undefined;
            return;
        }
        hover = Math.min(ticks.length - 1, Math.max(0, Math.floor((px - PAD_LEFT) / stepWidth)));
    }

    const hovered = $derived.by(() => {
        if (hover === undefined) return undefined;
        const tick = ticks[hover];
        const reading = tick.context.latest_value;
        const age = tick.context.last_reading_at ? (tickMs[hover] - Date.parse(tick.context.last_reading_at)) / 60_000 : 0;
        return {
            at: tickMs[hover],
            glucose: reading === undefined ? undefined : `${formatGlucoseValue(reading, units)} ${getUnitLabel(units)}`,
            trend: tick.context.trend_rate,
            age,
        };
    });

    /** Lines the chart draws for each glucose value a rule compares against. */
    const references = $derived.by(() => {
        const lines: [number, string][] = [];
        editing.forEach((rule, index) => {
            for (const leaf of leaves(collapse(rule.condition))) {
                if (leaf.type === "threshold" && !lines.some(([v]) => v === leaf.threshold.value))
                    lines.push([leaf.threshold.value, RULE_COLOURS[index % RULE_COLOURS.length]]);
            }
        });
        return lines.filter(([v]) => v > Y_MIN && v < yMax);
    });

    function reset(): void {
        editing = initialRules();
    }

    const issueText: Record<string, string> = {
        minutes_not_positive: "a time of at least 1 minute",
        empty_window: "a time window that opens: from and to cannot be the same",
        invalid_time: "times written as HH:mm",
        conditions_empty: "at least one condition in every group",
    };
</script>

<figure class="not-prose my-6 overflow-hidden rounded-lg border bg-card text-card-foreground" data-testid="alert-simulator">
    <div class="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        {#if offered.length > 1}
            <ToggleGroup.Root
                type="single"
                value={scenarioId}
                onValueChange={(v: string) => {
                    const next = offered.find((s) => s.id === v);
                    if (next) scenarioId = next.id;
                }}
                variant="segmented"
                size="xs"
            >
                {#each offered as s (s.id)}
                    <ToggleGroup.Item value={s.id}>{s.label}</ToggleGroup.Item>
                {/each}
            </ToggleGroup.Root>
        {:else}
            <span class="text-sm font-medium">{active.label}</span>
        {/if}
        <span class="flex-1"></span>
        <ToggleGroup.Root
            type="single"
            value={units}
            onValueChange={(v: string) => {
                if (v === "mg/dl" || v === "mmol") glucoseUnits.current = v;
            }}
            variant="segmented"
            size="xs"
        >
            <ToggleGroup.Item value="mg/dl">mg/dL</ToggleGroup.Item>
            <ToggleGroup.Item value="mmol">mmol/L</ToggleGroup.Item>
        </ToggleGroup.Root>
    </div>

    <div class="px-3 pt-2 text-sm text-muted-foreground">{active.description}</div>

    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        class="relative px-0 pb-2"
        bind:clientWidth={width}
        {onpointermove}
        onpointerleave={() => (hover = undefined)}
    >
        {#if width > 0}
            <svg
                {width}
                height={CHART_HEIGHT}
                role="img"
                aria-label="Glucose readings for the {active.label.toLowerCase()} example, with the times each rule was alerting shaded."
            >
                <rect
                    x={PAD_LEFT}
                    y={y(180)}
                    width={plotWidth}
                    height={y(70) - y(180)}
                    fill="var(--muted)"
                    opacity="0.6"
                />
                {#each [70, 180, 250].filter((v) => v < yMax) as v (v)}
                    <text x={PAD_LEFT - 6} y={y(v) + 3} text-anchor="end" class="fill-muted-foreground text-2xs tabular-nums">
                        {convertToDisplayUnits(v, units)}
                    </text>
                {/each}
                {#each hourMarks as t (t)}
                    <line x1={x(t)} x2={x(t)} y1={CHART_TOP} y2={CHART_HEIGHT - CHART_BOTTOM} stroke="var(--border)" />
                    <text x={x(t)} y={CHART_HEIGHT - 6} text-anchor="middle" class="fill-muted-foreground text-2xs tabular-nums">
                        {clock(t)}
                    </text>
                {/each}
                {#each views as view (view.rule.id)}
                    {#each view.firing as [from, to] (from)}
                        <rect
                            x={x(from)}
                            y={CHART_TOP}
                            width={x(to) - x(from)}
                            height={CHART_HEIGHT - CHART_TOP - CHART_BOTTOM}
                            fill={view.colour}
                            opacity="0.12"
                        />
                    {/each}
                {/each}
                {#each references as [value, colour] (value)}
                    <line
                        x1={PAD_LEFT}
                        x2={width - PAD_RIGHT}
                        y1={y(value)}
                        y2={y(value)}
                        stroke={colour}
                        stroke-dasharray="4 3"
                    />
                {/each}
                {#each segments as points, i (i)}
                    <polyline {points} fill="none" stroke="var(--muted-foreground)" stroke-width="1" opacity="0.5" />
                {/each}
                {#each active.readings as r (r.at)}
                    <circle cx={x(r.at)} cy={y(r.mgdl)} r="2.5" fill={rangeColour(r.mgdl)} />
                {/each}
                {#if hover !== undefined}
                    <line
                        x1={x(tickMs[hover])}
                        x2={x(tickMs[hover])}
                        y1={CHART_TOP}
                        y2={CHART_HEIGHT - CHART_BOTTOM}
                        stroke="var(--foreground)"
                        opacity="0.4"
                    />
                {/if}
            </svg>

            <div class="space-y-3 px-3">
                {#each views as view, index (view.rule.id)}
                    <div class="space-y-1">
                        <div class="flex flex-wrap items-baseline gap-x-2 text-sm">
                            <span class="font-medium text-(--rule-colour)" style:--rule-colour={view.colour}>{view.rule.name}</span>
                            <span class="text-muted-foreground">{story(view)}</span>
                        </div>
                        {#each view.conditionLanes as lane, laneIndex (laneIndex)}
                            {@render strip(lane.label, lane.runs, "var(--muted-foreground)", 0.45)}
                        {/each}
                        {#if view.showsWhole}
                            {@render strip("Whole rule is true", view.met, view.colour, 0.45)}
                        {/if}
                        {@render strip("Alerting", view.firing, view.colour, 0.9, view.events)}
                        {#if issues[index]?.length}
                            <p class="text-sm text-destructive">
                                A save would be refused: this rule needs
                                {issues[index].map((i) => issueText[i.reason] ?? i.reason).join(", ")}.
                            </p>
                        {/if}
                    </div>
                {/each}
            </div>
        {/if}

        {#if hovered}
            <div class="mx-3 mt-2 rounded-md border bg-muted/40 px-2 py-1 text-xs tabular-nums text-muted-foreground">
                <span class="font-medium text-foreground">{clock(hovered.at)}</span>
                {#if hovered.glucose}
                    · {hovered.glucose}
                    {#if hovered.trend !== undefined}
                        · {hovered.trend < 0 ? "falling" : "rising"} {rate(Math.abs(hovered.trend), units)}
                    {/if}
                    {#if hovered.age >= 10}
                        · last reading {Math.round(hovered.age)} min ago
                    {/if}
                {:else}
                    · no reading yet
                {/if}
                {#each views as view (view.rule.id)}
                    · <span class="text-(--rule-colour)" style:--rule-colour={view.colour}>{view.rule.name}</span>:
                    {view.firingAt[hover ?? 0] ? "alerting" : view.metAt[hover ?? 0] ? "true, not alerting" : "not true"}
                {/each}
            </div>
        {/if}
    </div>

    {#if editable}
        <div class="space-y-3 border-t px-3 py-3">
            {#each editing as rule (rule.id)}
                <div class="space-y-1.5">
                    <div
                        class="text-sm font-medium text-(--rule-colour)"
                        style:--rule-colour={RULE_COLOURS[editing.indexOf(rule) % RULE_COLOURS.length]}
                    >
                        {rule.name}
                    </div>
                    <ConditionEditor group={rule.condition} {units} />
                </div>
            {/each}
            <Button variant="outline" size="xs" onclick={reset}>
                <RotateCcw /> Reset the example
            </Button>
        </div>
    {/if}

    <figcaption class="flex items-start gap-2 border-t bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        {#if failure}
            <BellOff class="mt-0.5 size-3.5 shrink-0" />
            <span>The alert engine could not run here ({failure}). The rest of this page still applies.</span>
        {:else}
            <Cpu class="mt-0.5 size-3.5 shrink-0" />
            <span>
                This runs Nocturne's own alert engine in your browser, one check every 5 minutes, as
                <strong>Replay</strong> does in the app. The readings are made up to show one behaviour; they
                are not anyone's data, and nothing here is medical advice.
            </span>
        {/if}
    </figcaption>
</figure>

{#snippet strip(label: string, spans: [number, number][], colour: string, opacity: number, events: { at: number; kind: string }[] = [])}
    <div>
        <div class="flex items-center gap-1 text-xs text-muted-foreground">
            {#if events.length}<Bell class="size-3" />{/if}
            {label}
        </div>
        <svg {width} height="12" aria-hidden="true">
            <rect x={PAD_LEFT} y="3" width={plotWidth} height="6" rx="3" fill="var(--muted)" />
            {#each spans as [from, to] (from)}
                <rect x={x(from)} y="2" width={Math.max(2, x(to) - x(from))} height="8" rx="2" fill={colour} {opacity} />
            {/each}
            {#each events.filter((e) => e.kind === "fired" || e.kind === "suppressed_by_dnd") as e (e.at)}
                <circle cx={x(e.at)} cy="6" r="4" fill={colour} stroke="var(--card)" stroke-width="1.5" />
            {/each}
            {#if hover !== undefined}
                <line x1={x(tickMs[hover])} x2={x(tickMs[hover])} y1="0" y2="12" stroke="var(--foreground)" opacity="0.4" />
            {/if}
        </svg>
    </div>
{/snippet}
