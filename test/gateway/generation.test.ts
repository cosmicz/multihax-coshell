import assert from "node:assert/strict";
import test from "node:test";
import { createGatewayHarness, OK, tick } from "../../src/gateway/index.ts";

test("a stale generation after markHumanOccupied is refused", async () => {
  const demo = createGatewayHarness();
  const stale = demo.envelope({ generation: 0 });

  const latched = demo.gateway.markHumanOccupied(demo.key());
  assert.equal(latched.ok, true);
  if (!latched.ok) throw new Error("expected a latch");
  assert.equal(latched.seat.generation, 1);
  assert.equal(latched.seat.mode, "HUMAN");

  const result = await demo.gateway.submit(stale);
  assert.equal(result.outcome, "refused");
  if (result.outcome !== "refused") throw new Error("expected refused");
  assert.equal(result.code, "STALE_GENERATION");
  assert.equal(demo.port.scriptCount, 0);
});

test("markHumanOccupied invalidates the generation of the other seat only when it shares the lease", async () => {
  const demo = createGatewayHarness();
  demo.gateway.markHumanOccupied(demo.key());

  const engineering = await demo.gateway.submit(
    demo.envelope({
      role: "engineering",
      intent: "system_power_request",
      args: { system: "reactor", level: 1 },
    }),
  );
  assert.equal(engineering.outcome, "accepted");
  assert.equal(demo.port.scriptCount, 1);
});

test("an in flight receipt is discarded when the generation moves on", async () => {
  const demo = createGatewayHarness({ plans: [{ hold: true }] });
  const pending = demo.gateway.submit(demo.envelope());
  await tick();
  assert.equal(demo.port.scriptCount, 1);

  demo.gateway.markHumanOccupied(demo.key());
  demo.port.release(0, OK);

  const result = await pending;
  assert.equal(result.outcome, "refused");
  if (result.outcome !== "refused") throw new Error("expected refused");
  assert.equal(result.code, "STALE_GENERATION");
  assert.equal(demo.gateway.seat(demo.key())?.mode, "HUMAN");
});

test("a queued write is discarded before it reaches the port", async () => {
  const demo = createGatewayHarness({ plans: [{ hold: true }] });
  const first = demo.gateway.submit(demo.envelope({ request_id: "req-1" }));
  await tick();
  const second = demo.gateway.submit(demo.envelope({ request_id: "req-2" }));
  await tick();
  assert.equal(demo.port.scriptCount, 1);

  demo.gateway.markHumanOccupied(demo.key());
  demo.port.release(0, OK);

  const inFlight = await first;
  assert.equal(inFlight.outcome, "refused");
  if (inFlight.outcome !== "refused") throw new Error("expected refused");
  assert.equal(inFlight.code, "STALE_GENERATION");
  const queued = await second;
  assert.equal(queued.outcome, "refused");
  if (queued.outcome !== "refused") throw new Error("expected refused");
  assert.equal(queued.code, "STALE_GENERATION");
  assert.equal(demo.port.scriptCount, 1);
});

test("pause discards queued and in flight work for the old generation", async () => {
  const demo = createGatewayHarness({ plans: [{ hold: true }] });
  const pending = demo.gateway.submit(demo.envelope());
  await tick();

  const paused = demo.gateway.pause(demo.key());
  assert.equal(paused.ok, true);
  if (!paused.ok) throw new Error("expected a pause");
  assert.equal(paused.seat.mode, "PAUSED");
  assert.equal(paused.seat.generation, 1);
  demo.port.release(0, OK);

  const result = await pending;
  assert.equal(result.outcome, "refused");
  if (result.outcome !== "refused") throw new Error("expected refused");
  assert.equal(result.code, "STALE_GENERATION");
});

test("resume after a human occupied seat yields a new usable generation", async () => {
  const demo = createGatewayHarness();
  const beforeHuman = demo.envelope({ request_id: "req-before" });
  demo.gateway.markHumanOccupied(demo.key());
  demo.gateway.reportNativeVacancy(demo.key(), true);

  const refused = await demo.gateway.submit(beforeHuman);
  assert.equal(refused.outcome, "refused");
  if (refused.outcome !== "refused") throw new Error("expected refused");
  assert.equal(refused.code, "STALE_GENERATION");

  const resumed = demo.gateway.resume(demo.key(), "agent:hue");
  assert.equal(resumed.ok, true);
  if (!resumed.ok) throw new Error("expected a resume");
  assert.equal(resumed.seat.generation, 2);

  const accepted = await demo.gateway.submit(
    demo.envelope({ request_id: "req-after", generation: resumed.seat.generation }),
  );
  assert.equal(accepted.outcome, "accepted");
  assert.equal(demo.port.scriptCount, 1);
});

test("claimAgent rebinds the lease without moving the generation", async () => {
  const demo = createGatewayHarness({ claims: [] });
  const claim = demo.gateway.claimAgent(demo.key(), "agent:first");
  assert.equal(claim.ok, true);
  if (!claim.ok) throw new Error("expected a claim");
  assert.equal(claim.seat.generation, 0);
  assert.equal(claim.seat.leaseholder, "agent:first");

  const steal = demo.gateway.claimAgent(demo.key(), "agent:second");
  assert.equal(steal.ok, true);
  if (!steal.ok) throw new Error("expected a claim");
  assert.equal(steal.seat.leaseholder, "agent:second");

  const refused = await demo.gateway.submit(demo.envelope({ actor_id: "agent:first" }));
  assert.equal(refused.outcome, "refused");
  if (refused.outcome !== "refused") throw new Error("expected refused");
  assert.equal(refused.code, "NOT_LEASEHOLDER");
  assert.equal(demo.port.scriptCount, 0);
});