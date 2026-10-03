import assert from "node:assert/strict";
import test from "node:test";
import { createGatewayHarness } from "../../src/gateway/index.ts";

test("a valid helms impulse makes exactly one script containing commandImpulse", async () => {
  const demo = createGatewayHarness();
  const result = await demo.gateway.submit(
    demo.envelope({ intent: "impulse_fraction", args: { impulse_fraction: 0.5 } }),
  );

  assert.equal(demo.port.scriptCount, 1);
  assert.equal(result.outcome, "accepted");
  assert.equal(demo.port.lastScript().includes("commandImpulse(0.500)"), true);
  assert.deepEqual(demo.eventTypes(), ["accepted", "upstream_receipt"]);
  if (result.outcome !== "accepted") throw new Error("expected accepted");
  assert.equal(result.stage, "upstream_receipt");
  assert.equal(result.seat, "7:HORIZON:helms");
  assert.deepEqual(result.receipt, { ok: true });
});

test("a heading intent is sent as commandTargetRotation with heading minus 90", async () => {
  const demo = createGatewayHarness();
  const forward = await demo.gateway.submit(
    demo.envelope({ intent: "heading_degrees", args: { heading_degrees: 0 } }),
  );
  const beam = await demo.gateway.submit(
    demo.envelope({ intent: "heading_degrees", args: { heading_degrees: 90 } }),
  );
  const quarter = await demo.gateway.submit(
    demo.envelope({ intent: "heading_degrees", args: { heading_degrees: 45.6789 } }),
  );

  assert.equal(forward.outcome, "accepted");
  assert.equal(beam.outcome, "accepted");
  assert.equal(quarter.outcome, "accepted");
  assert.equal(demo.port.scriptCount, 3);
  assert.equal(demo.port.scripts[0].includes("commandTargetRotation(-90.00)"), true);
  assert.equal(demo.port.scripts[1].includes("commandTargetRotation(0.00)"), true);
  assert.equal(demo.port.scripts[2].includes("commandTargetRotation(-44.32)"), true);
});

test("engineering intents are sent as the allowlisted power and coolant commands", async () => {
  const demo = createGatewayHarness();
  const power = await demo.gateway.submit(
    demo.envelope({
      role: "engineering",
      intent: "system_power_request",
      args: { system: "reactor", level: 2 },
    }),
  );
  const coolant = await demo.gateway.submit(
    demo.envelope({
      role: "engineering",
      intent: "system_coolant_request",
      args: { system: "warp", level: 5 },
    }),
  );

  assert.equal(power.outcome, "accepted");
  assert.equal(coolant.outcome, "accepted");
  assert.equal(demo.port.scriptCount, 2);
  assert.equal(
    demo.port.scripts[0].includes('commandSetSystemPowerRequest("reactor", 2.0)'),
    true,
  );
  assert.equal(
    demo.port.scripts[1].includes('commandSetSystemCoolantRequest("warp", 5.0)'),
    true,
  );
  assert.equal(demo.port.scripts[1].includes('hasPlayerCrewAtPosition(s, "engineering+")'), true);
});

test("impulse fractions at the range edges are accepted", async () => {
  const demo = createGatewayHarness();
  const full = await demo.gateway.submit(
    demo.envelope({ args: { impulse_fraction: 1 } }),
  );
  const reverse = await demo.gateway.submit(
    demo.envelope({ args: { impulse_fraction: -1 } }),
  );

  assert.equal(full.outcome, "accepted");
  assert.equal(reverse.outcome, "accepted");
  assert.equal(demo.port.scriptCount, 2);
  assert.equal(demo.port.scripts[0].includes("commandImpulse(1.000)"), true);
  assert.equal(demo.port.scripts[1].includes("commandImpulse(-1.000)"), true);
});

test("an accepted write is stamped with the seat, the generation and the rendered script", async () => {
  const demo = createGatewayHarness();
  const result = await demo.gateway.submit(demo.envelope());
  if (result.outcome !== "accepted") throw new Error("expected accepted");

  assert.equal(result.request_id.startsWith("req-"), true);
  assert.equal(result.generation, 0);
  assert.equal(result.intent, "impulse_fraction");
  assert.equal(result.lua, demo.port.scripts[0]);
  assert.equal(result.lua.includes('s:getCallSign() ~= "HORIZON"'), true);
});