import assert from "node:assert/strict";
import test from "node:test";
import { createGatewayHarness } from "../../src/gateway/index.ts";

test("an identical duplicate request returns the prior result with no new io", async () => {
  const demo = createGatewayHarness();
  const envelope = demo.envelope({ request_id: "req-dup", args: { impulse_fraction: 0.25 } });

  const first = await demo.gateway.submit(envelope);
  const second = await demo.gateway.submit({ ...envelope });

  assert.equal(first.outcome, "accepted");
  assert.deepEqual(second, first);
  assert.equal(demo.port.scriptCount, 1);
  assert.deepEqual(demo.eventTypes(), ["accepted", "upstream_receipt"]);
});

test("a duplicate request with a different payload is refused as DUPLICATE_MISMATCH", async () => {
  const demo = createGatewayHarness();
  const first = await demo.gateway.submit(
    demo.envelope({ request_id: "req-dup", args: { impulse_fraction: 0.25 } }),
  );
  const clash = await demo.gateway.submit(
    demo.envelope({ request_id: "req-dup", args: { impulse_fraction: 0.75 } }),
  );

  assert.equal(first.outcome, "accepted");
  assert.equal(clash.outcome, "refused");
  if (clash.outcome !== "refused") throw new Error("expected refused");
  assert.equal(clash.code, "DUPLICATE_MISMATCH");
  assert.equal(demo.port.scriptCount, 1);
});

test("a differing duplicate is refused for every field that matters", async () => {
  const demo = createGatewayHarness();
  const base = demo.envelope({ request_id: "req-dup" });
  await demo.gateway.submit(base);
  const variants = [
    demo.envelope({ request_id: "req-dup", args: { impulse_fraction: 0.9 } }),
    demo.envelope({ request_id: "req-dup", intent: "heading_degrees", args: { heading_degrees: 10 } }),
    demo.envelope({ request_id: "req-dup", observation_seq: base.observation_seq + 5 }),
    demo.envelope({ request_id: "req-dup", actor_id: "agent:other" }),
    demo.envelope({ request_id: "req-dup", role: "engineering" }),
  ];

  for (const variant of variants) {
    const result = await demo.gateway.submit(variant);
    assert.equal(result.outcome, "refused");
    if (result.outcome !== "refused") throw new Error("expected refused");
    assert.equal(result.code, "DUPLICATE_MISMATCH");
  }
  assert.equal(demo.port.scriptCount, 1);
});

test("concurrent duplicates collapse onto a single write", async () => {
  const demo = createGatewayHarness();
  const envelope = demo.envelope({ request_id: "req-race", args: { impulse_fraction: -0.5 } });

  const results = await Promise.all([
    demo.gateway.submit(envelope),
    demo.gateway.submit({ ...envelope }),
    demo.gateway.submit({ ...envelope }),
  ]);

  assert.equal(demo.port.scriptCount, 1);
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[2], results[0]);
});

test("argument key order does not make a payload look different", async () => {
  const demo = createGatewayHarness();
  const first = await demo.gateway.submit(
    demo.envelope({
      request_id: "req-order",
      observation_seq: 5,
      role: "engineering",
      intent: "system_power_request",
      args: { system: "reactor", level: 3 },
    }),
  );
  const reordered = await demo.gateway.submit(
    demo.envelope({
      request_id: "req-order",
      observation_seq: 5,
      role: "engineering",
      intent: "system_power_request",
      args: { level: 3, system: "reactor" },
    }),
  );

  assert.equal(first.outcome, "accepted");
  assert.deepEqual(reordered, first);
  assert.equal(demo.port.scriptCount, 1);
});

test("a DUPLICATE_MISMATCH refusal is not cached over the original request", async () => {
  const demo = createGatewayHarness();
  const original = demo.envelope({ request_id: "req-keep", args: { impulse_fraction: 0.1 } });
  const first = await demo.gateway.submit(original);

  const clash = await demo.gateway.submit(
    demo.envelope({ request_id: "req-keep", args: { impulse_fraction: 0.2 } }),
  );
  const replay = await demo.gateway.submit({ ...original });

  assert.equal(first.outcome, "accepted");
  assert.equal(clash.outcome, "refused");
  assert.deepEqual(replay, first);
  assert.equal(demo.port.scriptCount, 1);
});

test("a refusal is replayed for the same request_id without new io", async () => {
  const demo = createGatewayHarness();
  const envelope = demo.envelope({ request_id: "req-refused", actor_id: "agent:other" });

  const first = await demo.gateway.submit(envelope);
  const second = await demo.gateway.submit({ ...envelope });

  assert.equal(first.outcome, "refused");
  assert.deepEqual(second, first);
  assert.equal(demo.port.scriptCount, 0);
});