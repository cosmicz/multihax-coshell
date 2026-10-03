import assert from "node:assert/strict";
import test from "node:test";
import { createGatewayHarness, sleep } from "../../src/gateway/index.ts";
import type { WorldPort } from "../../src/gateway/index.ts";

test("http 200 with an error field is failed", async () => {
  const demo = createGatewayHarness({
    plans: [{ status: 200, body: '{"error":"SHIP_MISMATCH"}' }],
  });
  const result = await demo.gateway.submit(demo.envelope());

  assert.equal(result.outcome, "failed");
  if (result.outcome !== "failed") throw new Error("expected failed");
  assert.equal(result.reason, "upstream_error");
  assert.equal(result.status, 200);
  assert.equal(demo.port.scriptCount, 1);
  assert.deepEqual(demo.eventTypes(), ["accepted", "failed"]);
});

test("a non 200 status is failed", async () => {
  const demo = createGatewayHarness({ plans: [{ status: 503, body: '{"ok":true}' }] });
  const result = await demo.gateway.submit(demo.envelope());

  assert.equal(result.outcome, "failed");
  if (result.outcome !== "failed") throw new Error("expected failed");
  assert.equal(result.reason, "http_error");
  assert.equal(result.status, 503);
  assert.equal(demo.port.scriptCount, 1);
});

test("an invalid json body is failed", async () => {
  const demo = createGatewayHarness({ plans: [{ status: 200, body: "not json at all" }] });
  const result = await demo.gateway.submit(demo.envelope());

  assert.equal(result.outcome, "failed");
  if (result.outcome !== "failed") throw new Error("expected failed");
  assert.equal(result.reason, "invalid_json");
  assert.equal(result.body, "not json at all");
});

test("a json body that is not a receipt is failed", async () => {
  const demo = createGatewayHarness({ plans: [{ status: 200, body: "[1,2,3]" }] });
  const result = await demo.gateway.submit(demo.envelope());
  assert.equal(result.outcome, "failed");
  if (result.outcome !== "failed") throw new Error("expected failed");
  assert.equal(result.reason, "unexpected_body");

  const quiet = createGatewayHarness({ plans: [{ status: 200, body: '{"ok":"yes"}' }] });
  const second = await quiet.gateway.submit(quiet.envelope());
  assert.equal(second.outcome, "failed");
  if (second.outcome !== "failed") throw new Error("expected failed");
  assert.equal(second.reason, "unexpected_body");
});

test("a port that throws is failed and never retried", async () => {
  const scripts: string[] = [];
  const port: WorldPort = {
    async execLua(script: string) {
      scripts.push(script);
      throw new Error("socket hang up");
    },
  };
  const demo = createGatewayHarness({ port });
  const result = await demo.gateway.submit(demo.envelope());

  assert.equal(result.outcome, "failed");
  if (result.outcome !== "failed") throw new Error("expected failed");
  assert.equal(result.reason, "http_error");
  assert.equal(result.status, 0);
  assert.equal(result.body.includes("socket hang up"), true);
  assert.equal(scripts.length, 1);
});

test("a timeout is reported as timeout and is never retried", async () => {
  const demo = createGatewayHarness({ plans: ["hang", "hang"], timeout_ms: 20 });
  const envelope = demo.envelope({ request_id: "req-timeout" });

  const first = await demo.gateway.submit(envelope);
  assert.equal(first.outcome, "timeout");
  if (first.outcome !== "timeout") throw new Error("expected timeout");
  assert.equal(first.timeout_ms, 20);
  assert.equal(demo.port.scriptCount, 1);
  assert.deepEqual(demo.eventTypes(), ["accepted", "timeout"]);

  await sleep(60);
  assert.equal(demo.port.scriptCount, 1);

  const replay = await demo.gateway.submit({ ...envelope });
  assert.equal(replay.outcome, "timeout");
  assert.equal(demo.port.scriptCount, 1);

  const fresh = await demo.gateway.submit(demo.envelope({ request_id: "req-after-timeout" }));
  assert.equal(fresh.outcome, "timeout");
  assert.equal(demo.port.scriptCount, 2);
});

test("an OCCUPIED receipt latches the seat to HUMAN and resume waits for vacancy", async () => {
  const demo = createGatewayHarness({
    plans: [{ status: 200, body: '{"refused":"OCCUPIED"}' }],
  });
  const result = await demo.gateway.submit(demo.envelope());

  assert.equal(result.outcome, "refused");
  if (result.outcome !== "refused") throw new Error("expected refused");
  assert.equal(result.code, "OCCUPIED");
  assert.equal(demo.port.scriptCount, 1);

  const latched = demo.gateway.seat(demo.key());
  assert.equal(latched?.mode, "HUMAN");
  assert.equal(latched?.human_latched, true);
  assert.equal(latched?.native_vacant, false);
  assert.equal(latched?.generation, 1);

  const blocked = demo.gateway.resume(demo.key(), "agent:hue");
  assert.equal(blocked.ok, false);
  if (blocked.ok) throw new Error("expected an OCCUPIED refusal");
  assert.equal(blocked.code, "OCCUPIED");

  demo.gateway.reportNativeVacancy(demo.key(), true);
  const resumed = demo.gateway.resume(demo.key(), "agent:hue");
  assert.equal(resumed.ok, true);
  if (!resumed.ok) throw new Error("expected a resume");
  assert.equal(resumed.seat.mode, "AGENT");
  assert.equal(resumed.seat.human_latched, false);
  assert.equal(resumed.seat.generation, 2);
});

test("the seat stays unusable for commands until resume reports vacancy", async () => {
  const demo = createGatewayHarness({
    plans: [{ status: 200, body: '{"refused":"OCCUPIED"}' }],
  });
  await demo.gateway.submit(demo.envelope());
  const stale = await demo.gateway.submit(demo.envelope());
  assert.equal(stale.outcome, "refused");
  if (stale.outcome !== "refused") throw new Error("expected refused");
  assert.equal(stale.code, "SEAT_NOT_AGENT");
  assert.equal(demo.port.scriptCount, 1);

  demo.gateway.reportNativeVacancy(demo.key(), true);
  demo.gateway.resume(demo.key(), "agent:hue");
  const live = await demo.gateway.submit(demo.envelope());
  assert.equal(live.outcome, "accepted");
  assert.equal(demo.port.scriptCount, 2);
});

test("a receipt is only accepted when ok is true", async () => {
  const demo = createGatewayHarness({
    plans: [{ status: 200, body: '{"ok":true,"applied":1}' }],
  });
  const result = await demo.gateway.submit(demo.envelope());

  assert.equal(result.outcome, "accepted");
  if (result.outcome !== "accepted") throw new Error("expected accepted");
  assert.deepEqual(result.receipt, { ok: true, applied: 1 });
});