// A legacy Nightscout holding a fixed history, for the migration job to import. Unlike
// ./nightscout.ts it is not anchored to the request time: every record sits at a fixed instant in
// the past, so a spec can name the exact UTC time each one must arrive at.
//
// Entries outnumber the migration's page size (LegacyReadLimits.MaxMergedCount, 10 000), so the
// pull pages back across a boundary. Treatments and device statuses carry `created_at` strings as
// uploaders write them: with no offset (UTC), with `+10:00`, and with `Z`.

import { NIGHTSCOUT_API_SECRET_HEADER } from "./nightscout.ts";
import type { Vendor, VendorReply } from "./vendor.ts";

export const MIGRATION_DEVICE = "e2e-migration-source";
export const MIGRATION_PAGE_SIZE = 10_000;
export const MIGRATION_ENTRY_COUNT = MIGRATION_PAGE_SIZE + 25;
/** The newest entry; the rest step back five minutes each. */
export const MIGRATION_NEWEST_ENTRY = Date.parse("2026-03-01T00:00:00.000Z");
const FIVE_MINUTES = 5 * 60 * 1000;

export function migrationEntryDate(index: number): number {
  return MIGRATION_NEWEST_ENTRY - index * FIVE_MINUTES;
}

function entrySgv(index: number): number {
  return 60 + (index % 240);
}

let entryCache: object[] | undefined;
function entries(): object[] {
  entryCache ??= Array.from({ length: MIGRATION_ENTRY_COUNT }, (_, i) => {
    const date = migrationEntryDate(i);
    return {
      _id: "65f0" + i.toString(16).padStart(20, "0"),
      date,
      dateString: new Date(date).toISOString(),
      sgv: entrySgv(i),
      direction: "Flat",
      type: "sgv",
      device: MIGRATION_DEVICE,
      utcOffset: 0,
    };
  });
  return entryCache;
}

export interface MigrationTreatment {
  _id: string;
  eventType: string;
  created_at: string;
  /** The instant `created_at` names, read as UTC when it carries no offset. */
  expectedMills: number;
  insulin?: number;
  carbs?: number;
  notes?: string;
}

export const MIGRATION_TREATMENTS: MigrationTreatment[] = [
  { _id: "66a000000000000000000001", eventType: "Meal Bolus", created_at: "2026-02-20T12:00:00", expectedMills: Date.parse("2026-02-20T12:00:00Z"), insulin: 4, carbs: 40 },
  { _id: "66a000000000000000000002", eventType: "Correction Bolus", created_at: "2026-02-20T22:30:00+10:00", expectedMills: Date.parse("2026-02-20T12:30:00Z"), insulin: 1.25 },
  { _id: "66a000000000000000000003", eventType: "Carb Correction", created_at: "2026-02-20T14:15:30.250", expectedMills: Date.parse("2026-02-20T14:15:30.250Z"), carbs: 18 },
  { _id: "66a000000000000000000004", eventType: "Note", created_at: "2026-02-20T13:00:00.000Z", expectedMills: Date.parse("2026-02-20T13:00:00Z"), notes: "e2e migrated note" },
];

export interface MigrationDeviceStatus {
  _id: string;
  device: string;
  created_at: string;
  expectedMills: number;
  [key: string]: unknown;
}

// No inner timestamps (loop.timestamp, openaps iob time, pump clock): the decomposer prefers those
// over created_at, and created_at is what is under test.
export const MIGRATION_DEVICE_STATUSES: MigrationDeviceStatus[] = [
  {
    _id: "66b000000000000000000001",
    device: "loop://e2e-iphone",
    created_at: "2026-02-20T12:05:00",
    expectedMills: Date.parse("2026-02-20T12:05:00Z"),
    loop: { iob: { iob: 1.15 }, cob: { cob: 12 }, predicted: { values: [120, 118, 116] } },
    pump: { reservoir: 150.5, battery: { percent: 75 } },
    uploader: { battery: 88 },
  },
  {
    _id: "66b000000000000000000002",
    device: "openaps://e2e-phone",
    created_at: "2026-02-20T22:10:00+10:00",
    expectedMills: Date.parse("2026-02-20T12:10:00Z"),
    openaps: { iob: { iob: 0.8, basaliob: 0.2 }, suggested: { bg: 121, eventualBG: 110, reason: "e2e" } },
    pump: { reservoir: 80 },
    uploaderBattery: 66,
  },
];

export const MIGRATION_PROFILE_NAME = "E2E Migrated";

const profile = [
  {
    _id: "66c000000000000000000001",
    defaultProfile: MIGRATION_PROFILE_NAME,
    startDate: "2026-01-15T00:00:00.000Z",
    created_at: "2026-01-15T00:00:00.000Z",
    units: "mg/dl",
    store: {
      [MIGRATION_PROFILE_NAME]: {
        dia: 5,
        carbratio: [{ time: "00:00", value: 12, timeAsSeconds: 0 }],
        carbs_hr: 20,
        delay: 20,
        sens: [{ time: "00:00", value: 45, timeAsSeconds: 0 }],
        timezone: "UTC",
        basal: [{ time: "00:00", value: 0.75, timeAsSeconds: 0 }],
        target_low: [{ time: "00:00", value: 95, timeAsSeconds: 0 }],
        target_high: [{ time: "00:00", value: 135, timeAsSeconds: 0 }],
        startDate: "1970-01-01T00:00:00.000Z",
        units: "mg/dl",
      },
    },
  },
];

function wire(rows: { expectedMills: number; created_at: string }[]): { created_at: string }[] {
  return rows.map(({ expectedMills: _, ...row }) => row);
}

function page<T>(rows: T[], query: Record<string, string>): T[] {
  const count = Number(query.count ?? 10);
  return rows.slice(0, Number.isFinite(count) && count > 0 ? count : 10);
}

function byDate(query: Record<string, string>) {
  const lte = query["find[date][$lte]"];
  const gte = query["find[date][$gte]"];
  return (row: object) => {
    const date = (row as { date: number }).date;
    return (lte === undefined || date <= Number(lte)) && (gte === undefined || date >= Number(gte));
  };
}

// String comparison, as Mongo compares Nightscout's stored `created_at` strings.
function byCreatedAt(query: Record<string, string>) {
  const lte = query["find[created_at][$lte]"];
  const gte = query["find[created_at][$gte]"];
  return (row: { created_at: string }) => (lte === undefined || row.created_at <= lte) && (gte === undefined || row.created_at >= gte);
}

const ok = (body: unknown): VendorReply => ({ status: 200, body });
const count = (n: number): VendorReply => ok([{ _id: null, count: n }]);

export const nightscoutMigration: Vendor = {
  handle(request): VendorReply {
    if (request.headers["api-secret"]?.toLowerCase() !== NIGHTSCOUT_API_SECRET_HEADER) {
      return { status: 401, body: { status: 401, message: "Unauthorized" } };
    }

    switch (request.path) {
      case "/api/v1/count/entries/where":
        return count(MIGRATION_ENTRY_COUNT);
      case "/api/v1/count/treatments/where":
        return count(MIGRATION_TREATMENTS.length);
      case "/api/v1/count/devicestatus/where":
        return count(MIGRATION_DEVICE_STATUSES.length);
      case "/api/v1/entries.json":
        return ok(page(entries().filter(byDate(request.query)), request.query));
      case "/api/v1/treatments.json":
        return ok(page(wire(MIGRATION_TREATMENTS).filter(byCreatedAt(request.query)), request.query));
      case "/api/v1/devicestatus.json":
        return ok(page(wire(MIGRATION_DEVICE_STATUSES).filter(byCreatedAt(request.query)), request.query));
      case "/api/v1/profile.json":
        return ok(profile);
      default:
        return { status: 404, body: { status: 404, message: `fake nightscout has no ${request.path}` } };
    }
  },
};
