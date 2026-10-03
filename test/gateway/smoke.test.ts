import assert from "node:assert/strict";
import test from "node:test";
import {
  createFakeWorldPort,
  isValidCallsign,
  REFUSAL_CODES,
  RoleScopedGateway,
  renderLua,
  STATION_COVERAGE,
  SYSTEM_ALLOWLIST,
} from "../../src/gateway/index.ts";

test("smoke: the gateway binds a validated callsign at construction", () => {
  const port = createFakeWorldPort();
  assert.throws(() => new RoleScopedGateway({ ship: "bad callsign!", epoch: 1 }, port));
  assert.throws(() => new RoleScopedGateway({ ship: "X".repeat(33), epoch: 1 }, port));
  assert.throws(() => new RoleScopedGateway({ ship: "A", epoch: 1.5 }, port));
  assert.throws(() => new RoleScopedGateway({ ship: "A", epoch: 1, timeout_ms: 0 }, port));
  assert.throws(
    () => new RoleScopedGateway({ ship: "A", epoch: 1 }, { execLua: "nope" } as never),
  );

  const gateway = new RoleScopedGateway({ ship: "HORIZON", epoch: 7 }, port);
  assert.equal(gateway.callsign, "HORIZON");
  assert.equal(gateway.currentEpoch, 7);
  assert.equal(gateway.requestTimeoutMs, 5000);
  assert.equal(isValidCallsign("HORIZON"), true);
});

test("smoke: both seats start PAUSED with nobody holding the lease", () => {
  const gateway = new RoleScopedGateway({ ship: "HORIZON", epoch: 7 }, createFakeWorldPort());
  const helms = gateway.seat({ epoch: 7, ship: "HORIZON", role: "helms" });
  const engineering = gateway.seat({ epoch: 7, ship: "HORIZON", role: "engineering" });

  assert.equal(helms?.id, "7:HORIZON:helms");
  assert.equal(engineering?.id, "7:HORIZON:engineering");
  assert.equal(helms?.mode, "PAUSED");
  assert.equal(helms?.generation, 0);
  assert.equal(helms?.leaseholder, null);
  assert.equal(gateway.claimAgent({ epoch: 7, ship: "HORIZON", role: "helms" }, "agent:hue").ok, true);
  assert.equal(
    gateway.seat({ epoch: 7, ship: "HORIZON", role: "helms" })?.mode,
    "AGENT",
  );
});

test("smoke: the static allowlists match the design", () => {
  assert.deepEqual(SYSTEM_ALLOWLIST, [
    "reactor",
    "beamweapons",
    "missilesystem",
    "maneuver",
    "impulse",
    "warp",
    "jumpdrive",
    "frontshield",
    "rearshield",
  ]);
  assert.deepEqual(STATION_COVERAGE.helms, ["helms", "tactical", "singlepilot"]);
  assert.deepEqual(STATION_COVERAGE.engineering, [
    "engineering",
    "engineering+",
    "powermanagement",
    "damagecontrol",
    "singlepilot",
  ]);
  assert.deepEqual(REFUSAL_CODES, [
    "UNKNOWN_INTENT",
    "WRONG_ROLE",
    "NOT_LEASEHOLDER",
    "STALE_GENERATION",
    "EPOCH_MISMATCH",
    "STALE_OBSERVATION",
    "SEAT_NOT_AGENT",
    "OUT_OF_RANGE",
    "DUPLICATE_MISMATCH",
    "OCCUPIED",
  ]);
  assert.equal(renderLua({
    callsign: "HORIZON",
    role: "helms",
    intent: { intent: "impulse_fraction", impulse_fraction: 0.5 },
  }).split("\n").length, 5);
});