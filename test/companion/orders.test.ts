import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createFakeCompanion } from "../../src/companion/fake.ts";
import { createServer } from "../../src/companion/server.ts";
import { ORDER_TEXT_MAX } from "../../src/companion/types.ts";
import type { Controller, Role } from "../../src/companion/types.ts";

async function withServer(
  run: (base: string, calls: { pause: Role[]; resume: Role[] }) => Promise<void>,
): Promise<void> {
  const fake = createFakeCompanion({ clock: () => 1_700_000_000_000 });
  const calls: { pause: Role[]; resume: Role[] } = { pause: [], resume: [] };
  const controller: Controller = {
    occupancy: (role) => fake.controller.occupancy(role),
    pause: (role) => {
      calls.pause.push(role);
      return fake.controller.pause(role);
    },
    resume: (role) => {
      calls.resume.push(role);
      return fake.controller.resume(role);
    },
  };
  const server: Server = createServer({ state: fake.state, controller });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  try {
    await run("http://127.0.0.1:" + String(address.port), calls);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}

async function postOrder(base: string, body: unknown): Promise<{ status: number; payload: Record<string, unknown> }> {
  const response = await fetch(base + "/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: (await response.json()) as Record<string, unknown> };
}

test("order with an unknown role is rejected with 400", async () => {
  await withServer(async (base) => {
    const result = await postOrder(base, { to_role: "navigator", text: "take us to the moon" });
    assert.equal(result.status, 400);
    assert.equal(result.payload["reason"], "BAD_ROLE");
  });
});

test("order with a missing role is rejected with 400", async () => {
  await withServer(async (base) => {
    const result = await postOrder(base, { text: "hold the line" });
    assert.equal(result.status, 400);
    assert.equal(result.payload["reason"], "BAD_ROLE");
  });
});

test("order with empty text is rejected with 400", async () => {
  await withServer(async (base) => {
    for (const text of ["", "   ", "\n\t"]) {
      const result = await postOrder(base, { to_role: "helms", text });
      assert.equal(result.status, 400);
      assert.equal(result.payload["reason"], "BAD_TEXT");
    }
  });
});

test("order longer than 280 characters is rejected with 400", async () => {
  await withServer(async (base) => {
    const tooLong = await postOrder(base, { to_role: "helms", text: "x".repeat(ORDER_TEXT_MAX + 1) });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.payload["reason"], "BAD_TEXT");

    const atLimit = await postOrder(base, { to_role: "helms", text: "y".repeat(ORDER_TEXT_MAX) });
    assert.equal(atLimit.status, 202);
  });
});

test("valid order is appended to the timeline and the addressed inbox without actuating", async () => {
  await withServer(async (base, calls) => {
    const before = await (await fetch(base + "/api/state")).json();
    const beforeTimeline = (before as { timeline: unknown[] }).timeline;

    const result = await postOrder(base, { to_role: "engineering", text: "  reroute power to shields  " });
    assert.equal(result.status, 202);
    assert.equal(result.payload["actuated"], false);

    const after = (await (await fetch(base + "/api/state")).json()) as {
      timeline: { kind: string; role: string; text: string }[];
    };
    assert.equal(after.timeline.length, beforeTimeline.length + 1);
    const entry = after.timeline[after.timeline.length - 1];
    assert.ok(entry);
    assert.equal(entry.kind, "order");
    assert.equal(entry.role, "engineering");
    assert.equal(entry.text, "reroute power to shields");

    assert.deepEqual(calls, { pause: [], resume: [] });
  });
});

test("malformed and oversized bodies are rejected with 400", async () => {
  await withServer(async (base) => {
    const notJson = await fetch(base + "/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(notJson.status, 400);

    const notObject = await fetch(base + "/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(["helms", "engage"]),
    });
    assert.equal(notObject.status, 400);

    const huge = await fetch(base + "/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to_role: "helms", text: "z".repeat(70_000) }),
    }).catch(() => ({ status: 400 }));
    assert.equal(huge.status, 400);
  });
});

test("GET on the orders route is not allowed", async () => {
  await withServer(async (base) => {
    const response = await fetch(base + "/api/orders");
    assert.equal(response.status, 405);
  });
});