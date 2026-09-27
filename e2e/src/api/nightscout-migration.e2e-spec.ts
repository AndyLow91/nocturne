import { beforeAll, describe, expect, it } from "vitest";
import { eventually } from "../helpers/http.ts";
import { seedTenant, type Tenant } from "../helpers/tenant.ts";
import {
  MIGRATION_DEVICE_STATUSES,
  MIGRATION_ENTRY_COUNT,
  MIGRATION_PAGE_SIZE,
  MIGRATION_PROFILE_NAME,
  MIGRATION_TREATMENTS,
  migrationEntryDate,
} from "../../mocks/vendors/nightscout-migration.ts";

const SOURCE_SECRET = "e2e-fake-nightscout-secret";
// At the root of its own host: the job keeps only the origin of the URL it is given.
const SOURCE_URL = "http://nightscout-migration:8080";
const COLLECTIONS = ["entries", "treatments", "devicestatus", "profile"];

// MigrationJobState, serialized as its number.
const COMPLETED = 3;
const TERMINAL = new Set([3, 4, 5, 6]);

interface MigrationJobInfo {
  id: string;
}

interface CollectionProgress {
  documentsMigrated: number;
  documentsFailed: number;
  failureReason: string | null;
  isComplete: boolean;
}

interface MigrationJobStatus {
  state: number;
  errorMessage: string | null;
  collectionProgress: Record<string, CollectionProgress>;
}

interface V1Entry {
  date: number;
  sgv: number;
}

interface V1Treatment {
  eventType: string;
  created_at: string;
  insulin?: number;
  carbs?: number;
  notes?: string;
}

interface V1DeviceStatus {
  created_at: string;
}

interface V1Profile {
  defaultProfile: string;
  store: Record<string, unknown>;
}

async function migrate(tenant: Tenant): Promise<MigrationJobStatus> {
  const job = await tenant.api.ok<MigrationJobInfo>("POST", "/api/v4/migration/start", {
    mode: 0,
    nightscoutUrl: SOURCE_URL,
    nightscoutApiSecret: SOURCE_SECRET,
    collections: COLLECTIONS,
  });
  return eventually(
    async () => {
      const status = await tenant.api.ok<MigrationJobStatus>("GET", `/api/v4/migration/${job.id}/status`);
      return TERMINAL.has(status.state) ? status : undefined;
    },
    { what: "the migration job to finish", timeoutMs: 120_000, intervalMs: 500 },
  );
}

async function entryCount(tenant: Tenant): Promise<number> {
  // A zero count is serialized as an empty object.
  return (await tenant.api.ok<{ count?: number }>("GET", "/api/v1/count/entries/where")).count ?? 0;
}

async function treatments(tenant: Tenant): Promise<V1Treatment[]> {
  return tenant.api.ok<V1Treatment[]>("GET", "/api/v1/treatments.json?count=100");
}

async function deviceStatuses(tenant: Tenant): Promise<V1DeviceStatus[]> {
  return tenant.api.ok<V1DeviceStatus[]>("GET", "/api/v1/devicestatus.json?count=100");
}

async function migratedProfiles(tenant: Tenant): Promise<V1Profile[]> {
  const profiles = await tenant.api.ok<V1Profile[]>("GET", "/api/v1/profile.json");
  return profiles.filter((p) => p.defaultProfile === MIGRATION_PROFILE_NAME);
}

describe("Nightscout migration", { timeout: 240_000 }, () => {
  let tenant: Tenant;
  let first: MigrationJobStatus;

  beforeAll(async () => {
    tenant = await seedTenant();
    first = await migrate(tenant);
  }, 180_000);

  it("completes every requested collection without failures", () => {
    expect(first.state).toBe(COMPLETED);
    expect(first.errorMessage).toBeNull();
    for (const name of COLLECTIONS) {
      expect(first.collectionProgress[name], name).toMatchObject({ isComplete: true, documentsFailed: 0, failureReason: null });
    }
    expect(first.collectionProgress.entries!.documentsMigrated).toBe(MIGRATION_ENTRY_COUNT);
    expect(first.collectionProgress.treatments!.documentsMigrated).toBe(MIGRATION_TREATMENTS.length);
    expect(first.collectionProgress.devicestatus!.documentsMigrated).toBe(MIGRATION_DEVICE_STATUSES.length);
  });

  it("imports every entry once, across the page boundary", async () => {
    expect(await entryCount(tenant)).toBe(MIGRATION_ENTRY_COUNT);

    // The oldest reading of the first page, the newest of the second, and the oldest overall.
    for (const index of [MIGRATION_PAGE_SIZE - 1, MIGRATION_PAGE_SIZE, MIGRATION_ENTRY_COUNT - 1]) {
      const date = migrationEntryDate(index);
      const found = await tenant.api.ok<V1Entry[]>("GET", `/api/v1/entries.json?find[date][$eq]=${date}`);
      expect(found.filter((e) => e.date === date), `entry ${index}`).toHaveLength(1);
    }
  });

  it("reads treatment times with no offset as UTC and honours an explicit offset", async () => {
    const stored = await treatments(tenant);
    for (const source of MIGRATION_TREATMENTS) {
      const matches = stored.filter((t) => t.eventType === source.eventType);
      expect(matches, source.eventType).toHaveLength(1);
      expect(Date.parse(matches[0]!.created_at), `${source.eventType} ${source.created_at}`).toBe(source.expectedMills);
    }
    expect(stored.find((t) => t.eventType === "Meal Bolus")).toMatchObject({ insulin: 4, carbs: 40 });
    expect(stored.find((t) => t.eventType === "Note")?.notes).toBe("e2e migrated note");
  });

  it("reads device status times with no offset as UTC and honours an explicit offset", async () => {
    const stored = (await deviceStatuses(tenant)).map((d) => Date.parse(d.created_at));
    for (const source of MIGRATION_DEVICE_STATUSES) {
      expect(stored.filter((t) => t === source.expectedMills), `${source.device} ${source.created_at}`).toHaveLength(1);
    }
    expect(stored).toHaveLength(MIGRATION_DEVICE_STATUSES.length);
  });

  it("imports the profile once", async () => {
    const profiles = await migratedProfiles(tenant);
    expect(profiles).toHaveLength(1);
    expect(Object.keys(profiles[0]!.store)).toContain(MIGRATION_PROFILE_NAME);
  });

  it("adds nothing when the same source is migrated again", async () => {
    const second = await migrate(tenant);
    expect(second.state).toBe(COMPLETED);
    expect(second.errorMessage).toBeNull();

    expect(await entryCount(tenant)).toBe(MIGRATION_ENTRY_COUNT);
    const stored = await treatments(tenant);
    for (const source of MIGRATION_TREATMENTS) {
      expect(stored.filter((t) => t.eventType === source.eventType), source.eventType).toHaveLength(1);
    }
    expect(await deviceStatuses(tenant)).toHaveLength(MIGRATION_DEVICE_STATUSES.length);
    expect(await migratedProfiles(tenant)).toHaveLength(1);
  });
});
