import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { minutesAgo, postEntries, postTreatments, sgvSeries } from "../helpers/data.ts";
import { HubConnection } from "../helpers/signalr.ts";
import { seedTenant, type Tenant } from "../helpers/tenant.ts";

interface StorageEvent {
  colName?: string;
  identifier?: string | null;
  doc?: Record<string, unknown>;
}

interface V1Treatment {
  _id: string;
  notes?: string;
}

const storage = (args: unknown[]) => (args[0] ?? {}) as StorageEvent;

// The API's DataHub, which the Socket.IO bridge relays to legacy clients: what it broadcasts is
// what every realtime client ends up with.
describe("realtime data hub", () => {
  let tenant: Tenant;
  let hub: HubConnection;

  beforeAll(async () => {
    tenant = await seedTenant();
    hub = await HubConnection.connect({ host: tenant.host, hub: "data", token: tenant.accessToken });
    const auth = await hub.invoke<{ success: boolean; read: boolean }>("Authorize", { client: "e2e", token: tenant.accessToken });
    expect(auth).toMatchObject({ success: true, read: true });
    const sub = await hub.invoke<{ success: boolean; collections: string[] }>("Subscribe", { collections: ["entries", "treatments"] });
    expect(sub.collections).toEqual(expect.arrayContaining(["entries", "treatments"]));
  });

  afterAll(() => hub?.close());

  it("pushes an uploaded entry as a create and a data update", async () => {
    const [entry] = sgvSeries({ count: 1, valueAt: () => 211, device: "e2e-realtime" });
    await postEntries(tenant.api, [entry!]);

    const [created] = await hub.waitFor("create", (a) => storage(a).colName === "entries" && storage(a).doc?.sgv === 211, {
      what: "the entry's create event",
    });
    expect(storage([created]).doc?.date).toBe(entry!.date);
    await hub.waitFor("dataUpdate", (a) => Array.isArray(a[0]) && a[0].some((r: { sgv?: number }) => r.sgv === 211), {
      what: "the entry's data update",
    });
  });

  it("pushes a deleted entry as a delete", async () => {
    const [entry] = sgvSeries({ count: 1, end: Date.now() - 60 * 60 * 1000, valueAt: () => 97, device: "e2e-realtime" });
    await postEntries(tenant.api, [entry!]);
    const [created] = await hub.waitFor("create", (a) => storage(a).colName === "entries" && storage(a).doc?.date === entry!.date, {
      what: "the entry's create event",
    });

    // Deleted by the id its create event carried, as a realtime client holds it.
    const del = await tenant.api.delete(`/api/v1/entries/${storage([created]).doc?._id}`);
    expect(del.status).toBeLessThan(300);
    await hub.waitFor("delete", (a) => storage(a).colName === "entries" && storage(a).doc?.date === entry!.date, {
      what: "the entry's delete event",
    });
  });

  it("pushes a treatment create and delete", async () => {
    const notes = `e2e realtime ${Date.now()}`;
    await postTreatments(tenant.api, [{ eventType: "Note", created_at: minutesAgo(15), notes, enteredBy: "e2e" }]);
    await hub.waitFor("create", (a) => storage(a).colName === "treatments" && storage(a).doc?.notes === notes, {
      what: "the treatment's create event",
    });

    const rest = (await tenant.api.ok<V1Treatment[]>("GET", "/api/v1/treatments.json?count=20")).find((t) => t.notes === notes);
    expect(rest).toBeDefined();
    const del = await tenant.api.delete(`/api/v1/treatments/${rest!._id}`);
    expect(del.status).toBeLessThan(300);
    const [deleted] = await hub.waitFor("delete", (a) => storage(a).colName === "treatments" && storage(a).doc?.notes === notes, {
      what: "the treatment's delete event",
    });
    expect(storage([deleted]).identifier).toBe(rest!._id);
  });

  it("delivers nothing written to another tenant", async () => {
    const other = await seedTenant();
    await postEntries(other.api, sgvSeries({ count: 1, valueAt: () => 199, device: "e2e-other-tenant" }));
    // Writes are broadcast before their request returns, so once this tenant's later write has
    // arrived, the other tenant's would have too.
    await postEntries(tenant.api, sgvSeries({ count: 1, end: Date.now() - 2 * 60 * 60 * 1000, valueAt: () => 212, device: "e2e-realtime" }));
    await hub.waitFor("create", (a) => storage(a).doc?.sgv === 212, { what: "this tenant's later create" });

    const leaked = hub.events.filter((e) => JSON.stringify(e.args).includes("e2e-other-tenant"));
    expect(leaked).toEqual([]);
  });
});

