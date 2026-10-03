import assert from "node:assert/strict";
import test from "node:test";
import { createGatewayHarness, OK, tick } from "../../src/gateway/index.ts";

test("writes for one ship are serialized even across seats", async () => {
  const demo = createGatewayHarness({ plans: [{ hold: true }] });

  const helms = demo.gateway.submit(demo.envelope({ request_id: "req-helms" }));
  await tick();
  const engineering = demo.gateway.submit(
    demo.envelope({
      request_id: "req-engineering",
      role: "engineering",
      intent: "system_power_request",
      args: { system: "reactor", level: 1 },
    }),
  );
  await tick();

  assert.equal(demo.port.scriptCount, 1);
  assert.equal(demo.port.maxConcurrent, 1);
  assert.equal(demo.port.scripts[0].includes("commandImpulse"), true);

  demo.port.release(0, OK);

  const first = await helms;
  const second = await engineering;
  assert.equal(first.outcome, "accepted");
  assert.equal(second.outcome, "accepted");
  assert.equal(demo.port.scriptCount, 2);
  assert.equal(demo.port.maxConcurrent, 1);
  assert.equal(demo.port.scripts[1].includes("commandSetSystemPowerRequest"), true);
});

test("a queued write keeps its order behind the write in flight", async () => {
  const demo = createGatewayHarness({ plans: [{ hold: true }] });
  const first = demo.gateway.submit(demo.envelope({ request_id: "req-a", args: { impulse_fraction: 0.1 } }));
  const second = demo.gateway.submit(demo.envelope({ request_id: "req-b", args: { impulse_fraction: 0.2 } }));
  await tick();
  demo.port.release(0, OK);

  assert.equal((await first).outcome, "accepted");
  assert.equal((await second).outcome, "accepted");
  assert.equal(demo.port.scriptCount, 2);
  assert.equal(demo.port.scripts[0].includes("commandImpulse(0.100)"), true);
  assert.equal(demo.port.scripts[1].includes("commandImpulse(0.200)"), true);
  assert.equal(demo.port.maxConcurrent, 1);
});

test("a timed out write does not block the queue", async () => {
  const demo = createGatewayHarness({ plans: [{ hold: true }], timeout_ms: 20 });

  const stuck = demo.gateway.submit(demo.envelope({ request_id: "req-stuck" }));
  const next = demo.gateway.submit(demo.envelope({ request_id: "req-next" }));
  const timedOut = await stuck;
  const after = await next;

  assert.equal(timedOut.outcome, "timeout");
  assert.equal(after.outcome, "accepted");
  assert.equal(demo.port.scriptCount, 2);
  demo.port.release(0, OK);
});

test("a refusal never enters the write queue", async () => {
  const demo = createGatewayHarness({ plans: [{ hold: true }] });
  const held = demo.gateway.submit(demo.envelope({ request_id: "req-held" }));
  await tick();
  const refused = await demo.gateway.submit(
    demo.envelope({ request_id: "req-refused", actor_id: "agent:other" }),
  );

  assert.equal(refused.outcome, "refused");
  assert.equal(demo.port.scriptCount, 1);
  demo.port.release(0, OK);
  assert.equal((await held).outcome, "accepted");
  assert.equal(demo.port.scriptCount, 1);
});