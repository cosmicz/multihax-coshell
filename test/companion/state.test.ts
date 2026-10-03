import assert from "node:assert/strict";
import test from "node:test";
import { MemoryState } from "../../src/companion/state.ts";
import { ROLES, STALE_AFTER_MS, STATION_ROLES } from "../../src/companion/types.ts";

test("roles are the five stations plus the app-level captain row", () => {
  assert.deepEqual([...STATION_ROLES], ["helms", "engineering", "weapons", "science", "relay"]);
  assert.deepEqual([...ROLES], ["captain", "helms", "engineering", "weapons", "science", "relay"]);

  const state = makeState(() => 1_000);
  assert.deepEqual(
    state.snapshot().seats.map((seat) => seat.role),
    ["captain", "helms", "engineering", "weapons", "science", "relay"],
  );
});

function makeState(now: () => number): MemoryState {
  return new MemoryState({
    ship: { name: "Horizon", type: "destroyer" },
    clock: now,
    mission: { status: "running", source: "scenario" },
  });
}

test("snapshot has the documented JSON shape", () => {
  const state = makeState(() => 1_000);
  const snapshot = state.snapshot();

  assert.deepEqual(Object.keys(snapshot).sort(), ["epoch", "mission", "seats", "ship", "timeline"]);
  assert.equal(typeof snapshot.epoch, "number");
  assert.deepEqual(Object.keys(snapshot.ship).sort(), ["name", "type"]);
  assert.deepEqual(snapshot.mission, { status: "running", source: "scenario" });
  assert.ok(Array.isArray(snapshot.seats));
  assert.ok(Array.isArray(snapshot.timeline));
  assert.equal(snapshot.seats.length, ROLES.length);

  for (const seat of snapshot.seats) {
    assert.deepEqual(Object.keys(seat).sort(), [
      "age_ms",
      "generation",
      "kind",
      "mode",
      "native_occupancy",
      "observed_at",
      "role",
      "stale",
    ]);
    assert.ok(["HUMAN", "AGENT", "PAUSED"].includes(seat.mode));
    assert.ok(["occupied", "vacant"].includes(seat.native_occupancy));
    assert.ok(["app", "station"].includes(seat.kind));
    assert.equal(typeof seat.generation, "number");
    assert.equal(typeof seat.observed_at, "number");
    assert.equal(typeof seat.age_ms, "number");
    assert.equal(typeof seat.stale, "boolean");
  }

  const captain = snapshot.seats.find((seat) => seat.role === "captain");
  const helms = snapshot.seats.find((seat) => seat.role === "helms");
  const engineering = snapshot.seats.find((seat) => seat.role === "engineering");
  assert.ok(captain);
  assert.ok(helms);
  assert.ok(engineering);
  assert.equal(captain.kind, "app");
  assert.equal(helms.kind, "station");
  assert.equal(engineering.kind, "station");

  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
});

test("seats older than five seconds are marked stale", () => {
  let now = 10_000;
  const state = makeState(() => now);
  state.observe("helms", { mode: "HUMAN", observedAt: now });
  state.observe("engineering", { mode: "AGENT", observedAt: now });

  assert.equal(state.snapshot().seats.find((seat) => seat.role === "helms")?.stale, false);

  now += STALE_AFTER_MS - 1;
  assert.equal(state.snapshot().seats.find((seat) => seat.role === "helms")?.stale, false);
  assert.equal(state.snapshot().seats.find((seat) => seat.role === "helms")?.age_ms, STALE_AFTER_MS - 1);

  now += 2;
  const helms = state.snapshot().seats.find((seat) => seat.role === "helms");
  assert.equal(helms?.stale, true);
  assert.equal(helms?.age_ms, STALE_AFTER_MS + 1);

  const untouched = state.snapshot().seats.find((seat) => seat.role === "science");
  assert.equal(untouched?.stale, true);
});

test("generation advances when a seat mode changes", () => {
  const state = makeState(() => 42);
  const before = state.snapshot().seats.find((seat) => seat.role === "weapons");
  assert.equal(before?.generation, 1);
  state.observe("weapons", { mode: "AGENT" });
  const after = state.snapshot().seats.find((seat) => seat.role === "weapons");
  assert.equal(after?.generation, 2);
  assert.equal(after?.mode, "AGENT");
  state.touch("weapons");
  const touched = state.snapshot().seats.find((seat) => seat.role === "weapons");
  assert.equal(touched?.generation, 2);
});