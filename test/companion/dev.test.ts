import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PORT, startDemoCompanion } from "../../src/companion/dev.ts";

test("the demo entry listens on the requested port and serves the page", async () => {
  assert.equal(DEFAULT_PORT, 8080);

  const demo = await startDemoCompanion({ port: 0, heartbeatMs: 50 });
  try {
    assert.ok(demo.port > 0);
    const page = await fetch("http://127.0.0.1:" + String(demo.port) + "/");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /native EmptyEpsilon client/i);

    const orders = await fetch("http://127.0.0.1:" + String(demo.port) + "/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to_role: "engineering", text: "shields to maximum" }),
    });
    assert.equal(orders.status, 202);
  } finally {
    await demo.close();
  }
});