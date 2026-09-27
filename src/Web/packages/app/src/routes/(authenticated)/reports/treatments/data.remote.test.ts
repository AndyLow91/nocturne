import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Bolus, CarbIntake, TreatmentSummaryRequest } from "$lib/api";

const boluses: Bolus[] = [
  { id: "b-pump", insulin: 4, mills: 1_000, device: "pump-a" },
  { id: "b-pen", insulin: 2, mills: 2_000, device: "pen-b" },
];
const carbIntakes: CarbIntake[] = [
  { id: "c-pump", carbs: 40, mills: 3_000, device: "pump-a" },
  { id: "c-app", carbs: 25, mills: 4_000, device: "phone-c" },
];
const bgChecks = [{ id: "g-pump", mgdl: 110, mills: 5_000, device: "pump-a" }];
const notes = [{ id: "n-1", text: "walk", mills: 6_000 }];

const summaryRequests: TreatmentSummaryRequest[] = [];

const page = <T>(data: T[]) => Promise.resolve({ data });

vi.mock("$app/server", () => ({
  getRequestEvent: () => ({
    locals: {
      apiClient: {
        bolus: { getAll: () => page(boluses) },
        nutrition: { getCarbIntakes: () => page(carbIntakes) },
        bGCheck: { getAll: () => page(bgChecks) },
        note: { getAll: () => page(notes) },
        deviceEvent: { getAll: () => page([]) },
        basalInjection: { getAll: () => page([]) },
        statistics: {
          calculateTreatmentSummary: (request: TreatmentSummaryRequest) => {
            summaryRequests.push(request);
            return Promise.resolve({ bolusCount: request.boluses?.length });
          },
        },
      },
    },
  }),
  query: (_schema: unknown, fn: unknown) => fn,
  command: (_schema: unknown, fn: unknown) => fn,
  form: (_schema: unknown, fn: unknown) => fn,
}));

vi.mock("$api/report-range", async (importOriginal) => ({
  ...(await importOriginal<typeof import("$api/report-range")>()),
  resolveReportRange: () =>
    Promise.resolve({
      startDate: "2026-01-01T00:00:00.000Z",
      endDate: "2026-01-03T23:59:59.999Z",
      dayCount: 3,
      timeZone: null,
      days: [],
    }),
}));

const { getTreatmentStats } = await import("./data.remote");

type Stats = {
  counts: Record<string, number>;
  treatmentSummary: unknown;
};
const statsFor = (category: string, search: string) =>
  (getTreatmentStats as unknown as (input: unknown) => Promise<Stats>)({
    category,
    search,
  });

/**
 * The stats card renders the counts and the backend summary side by side, so
 * both have to come from the one set of records the page's filter keeps.
 */
describe("Treatment Log stats", () => {
  beforeEach(() => {
    summaryRequests.length = 0;
  });

  it("summarises only the records the search keeps, and counts the same records", async () => {
    const stats = await statsFor("all", "pump-a");

    expect(summaryRequests).toHaveLength(1);
    const [request] = summaryRequests;
    expect(request.boluses?.map((b) => b.id)).toEqual(["b-pump"]);
    expect(request.carbIntakes?.map((c) => c.id)).toEqual(["c-pump"]);
    expect(request.dayCount).toBe(3);
    expect(stats.counts).toMatchObject({ all: 3, bolus: 1, carbs: 1, bgCheck: 1, note: 0 });
  });

  it("leaves carb intakes out of the summary when the category is insulin", async () => {
    const stats = await statsFor("bolus", "");

    const [request] = summaryRequests;
    expect(request.boluses?.map((b) => b.id)).toEqual(["b-pen", "b-pump"]);
    expect(request.carbIntakes).toEqual([]);
    expect(stats.counts).toMatchObject({ all: 2, bolus: 2, carbs: 0 });
  });

  it("has no summary when the filter keeps no boluses or carb intakes", async () => {
    const stats = await statsFor("bgCheck", "");

    expect(summaryRequests).toHaveLength(0);
    expect(stats.treatmentSummary).toBeNull();
    expect(stats.counts).toMatchObject({ all: 1, bgCheck: 1, bolus: 0, carbs: 0 });
  });
});
