import assert from "node:assert/strict";
import test from "node:test";
import { createGatewayHarness, REFUSAL_CODES } from "../../src/gateway/index.ts";
import type { GatewayResult, RefusedResult } from "../../src/gateway/index.ts";

async function refused(result: GatewayResult, code: string): Promise<RefusedResult> {
  assert.equal(result.outcome, "refused");
  if (result.outcome !== "refused") throw new Error("expected refused");
  assert.equal(result.code, code);
  assert.equal(REFUSAL_CODES.includes(result.code), true);
  return result;
}

test("UNKNOWN_INTENT is refused before any port io", async () => {
  const demo = createGatewayHarness();
  await refused(
    await demo.gateway.submit(demo.envelope({ intent: "self_destruct", args: {} })),
    "UNKNOWN_INTENT",
  );
  assert.equal(demo.port.scriptCount, 0);
});

test("WRONG_ROLE is refused for an intent from another seat", async () => {
  const demo = createGatewayHarness();
  await refused(
    await demo.gateway.submit(
      demo.envelope({
        role: "helms",
        intent: "system_power_request",
        args: { system: "reactor", level: 1 },
      }),
    ),
    "WRONG_ROLE",
  );
  await refused(
    await demo.gateway.submit(
      demo.envelope({ role: "engineering", intent: "impulse_fraction", args: { impulse_fraction: 0 } }),
    ),
    "WRONG_ROLE",
  );
  await refused(
    await demo.gateway.submit(demo.envelope({ role: "navigator" })),
    "WRONG_ROLE",
  );
  assert.equal(demo.port.scriptCount, 0);
});

test("NOT_LEASEHOLDER is refused for an actor that does not hold the lease", async () => {
  const demo = createGatewayHarness();
  await refused(
    await demo.gateway.submit(demo.envelope({ actor_id: "agent:other" })),
    "NOT_LEASEHOLDER",
  );
  assert.equal(demo.port.scriptCount, 0);
});

test("STALE_GENERATION is refused when the envelope generation is not the live one", async () => {
  const demo = createGatewayHarness();
  await refused(
    await demo.gateway.submit(demo.envelope({ generation: 99 })),
    "STALE_GENERATION",
  );
  await refused(
    await demo.gateway.submit(demo.envelope({ generation: 0.5 })),
    "STALE_GENERATION",
  );
  assert.equal(demo.port.scriptCount, 0);
});

test("EPOCH_MISMATCH is refused for a stale epoch or a foreign ship", async () => {
  const demo = createGatewayHarness();
  await refused(await demo.gateway.submit(demo.envelope({ epoch: 6 })), "EPOCH_MISMATCH");
  await refused(await demo.gateway.submit(demo.envelope({ ship: "ENDEAVOUR" })), "EPOCH_MISMATCH");
  assert.equal(demo.port.scriptCount, 0);
});

test("STALE_OBSERVATION is refused for an observation_seq older than the last accepted", async () => {
  const demo = createGatewayHarness();
  const fresh = await demo.gateway.submit(demo.envelope({ observation_seq: 40 }));
  assert.equal(fresh.outcome, "accepted");
  assert.equal(demo.port.scriptCount, 1);

  await refused(
    await demo.gateway.submit(demo.envelope({ observation_seq: 39 })),
    "STALE_OBSERVATION",
  );
  assert.equal(demo.port.scriptCount, 1);
});

test("SEAT_NOT_AGENT is refused while the seat is paused", async () => {
  const demo = createGatewayHarness();
  demo.gateway.pause(demo.key());
  await refused(await demo.gateway.submit(demo.envelope()), "SEAT_NOT_AGENT");
  assert.equal(demo.port.scriptCount, 0);
});

test("SEAT_NOT_AGENT is refused while a human holds the seat", async () => {
  const demo = createGatewayHarness();
  demo.gateway.markHumanOccupied(demo.key());
  await refused(await demo.gateway.submit(demo.envelope()), "SEAT_NOT_AGENT");
  assert.equal(demo.port.scriptCount, 0);
});

test("OUT_OF_RANGE is refused for every out of range or non finite number", async () => {
  const demo = createGatewayHarness();
  const cases: Array<Partial<Record<string, unknown>>> = [
    { intent: "impulse_fraction", args: { impulse_fraction: 1.5 } },
    { intent: "impulse_fraction", args: { impulse_fraction: -1.5 } },
    { intent: "impulse_fraction", args: { impulse_fraction: Number.NaN } },
    { intent: "heading_degrees", args: { heading_degrees: 360 } },
    { intent: "heading_degrees", args: { heading_degrees: -1 } },
    { intent: "heading_degrees", args: { heading_degrees: Number.POSITIVE_INFINITY } },
    {
      role: "engineering",
      intent: "system_power_request",
      args: { system: "reactor", level: 4 },
    },
    {
      role: "engineering",
      intent: "system_coolant_request",
      args: { system: "warp", level: 11 },
    },
    {
      role: "engineering",
      intent: "system_power_request",
      args: { system: "reactor", level: Number.NEGATIVE_INFINITY },
    },
    { intent: "impulse_fraction", args: { impulse_fraction: "0.5" } },
    { intent: "impulse_fraction", args: {} },
    { intent: "impulse_fraction", args: [] },
  ];
  for (const overrides of cases) {
    await refused(await demo.gateway.submit(demo.envelope(overrides)), "OUT_OF_RANGE");
  }
  assert.equal(demo.port.scriptCount, 0);
});

test("OCCUPIED is refused when a human is latched onto the native seat", async () => {
  const demo = createGatewayHarness();
  const latched = demo.gateway.markHumanOccupied(demo.key());
  assert.equal(latched.ok, true);
  if (!latched.ok) throw new Error("expected latch");

  const resumed = demo.gateway.resume(demo.key(), "agent:hue");
  assert.equal(resumed.ok, false);
  if (resumed.ok) throw new Error("expected an OCCUPIED refusal");
  assert.equal(resumed.code, "OCCUPIED");

  const claimed = demo.gateway.claimAgent(demo.key(), "agent:hue");
  assert.equal(claimed.ok, false);
  if (claimed.ok) throw new Error("expected an OCCUPIED refusal");
  assert.equal(claimed.code, "OCCUPIED");
  assert.equal(demo.port.scriptCount, 0);
});

test("every refusal happens before the port is touched", async () => {
  const demo = createGatewayHarness({ claims: ["helms"] });
  const seed = await demo.gateway.submit(demo.envelope({ observation_seq: 12 }));
  assert.equal(seed.outcome, "accepted");

  const results = await Promise.all([
    demo.gateway.submit(demo.envelope({ intent: "nope" })),
    demo.gateway.submit(demo.envelope({ role: "engineering" })),
    demo.gateway.submit(demo.envelope({ actor_id: "agent:other" })),
    demo.gateway.submit(demo.envelope({ generation: 41 })),
    demo.gateway.submit(demo.envelope({ epoch: 1 })),
    demo.gateway.submit(demo.envelope({ observation_seq: 11, request_id: "req-stale" })),
  ]);

  assert.deepEqual(
    results.map((result) => (result.outcome === "refused" ? result.code : result.outcome)),
    [
      "UNKNOWN_INTENT",
      "WRONG_ROLE",
      "NOT_LEASEHOLDER",
      "STALE_GENERATION",
      "EPOCH_MISMATCH",
      "STALE_OBSERVATION",
    ],
  );
  assert.equal(demo.port.scriptCount, 1);
});