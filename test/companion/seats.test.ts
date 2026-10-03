import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createFakeCompanion } from "../../src/companion/fake.ts";
import { createServer } from "../../src/companion/server.ts";
import type { Role } from "../../src/companion/types.ts";

interface Harness {
  base: string;
  seatAction: (role: Role, action: "pause" | "resume") => Promise<{
    status: number;
    payload: Record<string, unknown>;
  }>;
  snapshot: () => Promise<{
    seats: {
      role: Role;
      mode: string;
      stale: boolean;
      generation: number;
      native_occupancy: string;
    }[];
    timeline: { kind: string; role: Role | null }[];
  }>;
  occupy: (role: Role) => void;
  vacate: (role: Role) => void;
  paused: (role: Role) => boolean;
  close: () => Promise<void>;
}

async function harness(occupancy: Partial<Record<Role, "occupied" | "vacant">>): Promise<Harness> {
  const fake = createFakeCompanion({
    clock: () => 1_700_000_000_000,
    occupancy: { helms: "occupied", engineering: "vacant", ...occupancy },
  });
  const server: Server = createServer({ state: fake.state, controller: fake.controller });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const base = "http://127.0.0.1:" + String(address.port);

  return {
    base,
    seatAction: async (role, action) => {
      const response = await fetch(base + "/api/seats/" + role + "/" + action, { method: "POST" });
      return { status: response.status, payload: (await response.json()) as Record<string, unknown> };
    },
    snapshot: async () =>
      (await (await fetch(base + "/api/state")).json()) as Awaited<ReturnType<Harness["snapshot"]>>,
    paused: (role) => fake.controller.paused(role),
    occupy: (role) => {
      fake.controller.setOccupancy(role, "occupied");
    },
    vacate: (role) => {
      fake.controller.setOccupancy(role, "vacant");
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

test("resume is refused with 409 OCCUPIED while the native seat is occupied", async () => {
  const demo = await harness({});
  try {
    const result = await demo.seatAction("helms", "resume");
    assert.equal(result.status, 409);
    assert.equal(result.payload["reason"], "OCCUPIED");
    assert.equal(demo.paused("helms"), false);

    const snapshot = await demo.snapshot();
    const helms = snapshot.seats.find((seat) => seat.role === "helms");
    assert.equal(helms?.mode, "HUMAN");
  } finally {
    await demo.close();
  }
});

test("resume succeeds when the native seat is vacant and hands the seat to an agent", async () => {
  const demo = await harness({});
  try {
    const before = await demo.snapshot();
    const beforeEngineering = before.seats.find((seat) => seat.role === "engineering");
    assert.equal(beforeEngineering?.mode, "PAUSED");

    const result = await demo.seatAction("engineering", "resume");
    assert.equal(result.status, 200);
    assert.equal(result.payload["ok"], true);
    assert.equal(result.payload["mode"], "AGENT");
    assert.equal(
      result.payload["generation"],
      (beforeEngineering === undefined ? 0 : beforeEngineering.generation) + 1,
    );

    const snapshot = await demo.snapshot();
    const engineering = snapshot.seats.find((seat) => seat.role === "engineering");
    assert.equal(engineering?.mode, "AGENT");
    assert.ok(engineering !== undefined && engineering.generation > (beforeEngineering?.generation ?? 0));
    assert.equal(
      snapshot.timeline.some((entry) => entry.kind === "resume" && entry.role === "engineering"),
      true,
    );
  } finally {
    await demo.close();
  }
});

test("an agent never resumes automatically: vacant -> AGENT -> HUMAN -> PAUSED -> AGENT", async () => {
  const demo = await harness({ helms: "vacant" });
  try {
    const seat = async (): Promise<{
      mode: string;
      generation: number;
      native_occupancy: string;
    }> => {
      const snapshot = await demo.snapshot();
      const helms = snapshot.seats.find((entry) => entry.role === "helms");
      assert.ok(helms !== undefined);
      return helms;
    };

    const vacantBefore = await seat();
    assert.equal(vacantBefore.native_occupancy, "vacant");
    assert.equal(vacantBefore.mode, "PAUSED");

    const resumed = await demo.seatAction("helms", "resume");
    assert.equal(resumed.status, 200);
    assert.equal(resumed.payload["mode"], "AGENT");
    const agent = await seat();
    assert.equal(agent.mode, "AGENT");
    assert.ok(agent.generation > vacantBefore.generation);

    demo.occupy("helms");
    const occupied = await seat();
    assert.equal(occupied.native_occupancy, "occupied");
    assert.equal(occupied.mode, "HUMAN");

    demo.vacate("helms");
    const vacated = await seat();
    assert.equal(vacated.native_occupancy, "vacant");
    assert.equal(vacated.mode, "PAUSED");
    assert.equal(demo.paused("helms"), true);

    const resumedAgain = await demo.seatAction("helms", "resume");
    assert.equal(resumedAgain.status, 200);
    assert.equal(resumedAgain.payload["mode"], "AGENT");
    const agentAgain = await seat();
    assert.equal(agentAgain.mode, "AGENT");
    assert.ok(agentAgain.generation > vacated.generation);
  } finally {
    await demo.close();
  }
});

test("pause succeeds on a vacant seat and is refused when occupied", async () => {
  const demo = await harness({});
  try {
    const paused = await demo.seatAction("engineering", "pause");
    assert.equal(paused.status, 200);
    assert.equal(paused.payload["mode"], "PAUSED");
    assert.equal(demo.paused("engineering"), true);

    const snapshot = await demo.snapshot();
    const engineering = snapshot.seats.find((seat) => seat.role === "engineering");
    assert.equal(engineering?.mode, "PAUSED");
    assert.equal(
      snapshot.timeline.some((entry) => entry.kind === "pause" && entry.role === "engineering"),
      true,
    );

    const refused = await demo.seatAction("helms", "pause");
    assert.equal(refused.status, 409);
    assert.equal(refused.payload["reason"], "OCCUPIED");
  } finally {
    await demo.close();
  }
});

test("app-level captain row has no native seat and unknown roles are 404", async () => {
  const demo = await harness({});
  try {
    const captain = await demo.seatAction("captain", "resume");
    assert.equal(captain.status, 404);
    assert.equal(captain.payload["error"], "UNKNOWN_SEAT");

    const unknown = await fetch(demo.base + "/api/seats/navigator/resume", { method: "POST" });
    assert.equal(unknown.status, 404);

    const missing = await fetch(demo.base + "/api/state/nope", { method: "POST" });
    assert.equal(missing.status, 404);
  } finally {
    await demo.close();
  }
});

test("seat actions are POST only and the state route reports staleness", async () => {
  const demo = await harness({});
  try {
    const get = await fetch(demo.base + "/api/seats/engineering/pause");
    assert.equal(get.status, 405);

    const snapshot = await demo.snapshot();
    assert.equal(snapshot.seats.every((seat) => seat.stale === false), true);
  } finally {
    await demo.close();
  }
});