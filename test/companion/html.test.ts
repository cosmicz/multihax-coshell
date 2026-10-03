import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createFakeCompanion } from "../../src/companion/fake.ts";
import { createServer } from "../../src/companion/server.ts";
import type { MissionStatus } from "../../src/companion/types.ts";

const NOW = 1_700_000_000_000;

interface Page {
  status: number;
  body: string;
}

async function serve(): Promise<{
  state: ReturnType<typeof createFakeCompanion>["state"];
  get: (path: string) => Promise<Page>;
  postOrder: (body: unknown) => Promise<number>;
  close: () => Promise<void>;
}> {
  const fake = createFakeCompanion({
    clock: () => NOW,
    occupancy: { helms: "occupied", engineering: "vacant" },
    modes: { helms: "HUMAN", engineering: "AGENT" },
    mission: { status: "running", source: "scenario" },
  });
  const server: Server = createServer({ state: fake.state, controller: fake.controller });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const base = "http://127.0.0.1:" + String(address.port);
  return {
    state: fake.state,
    get: async (path: string) => {
      const response = await fetch(base + path);
      return { status: response.status, body: await response.text() };
    },
    postOrder: async (body: unknown) => {
      const response = await fetch(base + "/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return response.status;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

test("the page tells the operator that the native EmptyEpsilon client is required", async () => {
  const demo = await serve();
  try {
    const page = await demo.get("/");
    assert.equal(page.status, 200);
    assert.match(page.body, /native EmptyEpsilon client/i);
    assert.match(page.body, /helm,\s*engineering and every other ship control lives there/i);
    assert.match(page.body, /role="status"/);
  } finally {
    await demo.close();
  }
});

test("the page has no station control widgets", async () => {
  const demo = await serve();
  try {
    const page = await demo.get("/");
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.body, /type="range"/);
    assert.doesNotMatch(page.body, /type="number"/);
    assert.doesNotMatch(page.body, /type="checkbox"/);
    assert.doesNotMatch(page.body, /<input/i);
    assert.doesNotMatch(page.body, /thrust/i);
    assert.doesNotMatch(page.body, /slider/i);
    assert.doesNotMatch(page.body, /innerHTML/);
    assert.match(page.body, /data-action="resume"/);
    assert.match(page.body, /data-action="pause"/);
    assert.match(page.body, /var POLL_MS = 1000;/);
    assert.match(page.body, /setInterval\(poll, POLL_MS\)/);
    assert.match(page.body, /<td class="role">relay<\/td>/);
    assert.doesNotMatch(page.body, /engineeringChief/);
  } finally {
    await demo.close();
  }
});

test("user supplied order text is escaped in the served page", async () => {
  const demo = await serve();
  try {
    const payload = '<script>alert("xss")</script>';
    assert.equal(await demo.postOrder({ to_role: "helms", text: payload }), 202);

    const page = await demo.get("/");
    assert.equal(page.status, 200);
    assert.match(page.body, /&lt;script&gt;alert\(&quot;xss&quot;\)&lt;\/script&gt;/);
    assert.doesNotMatch(page.body, /<script>alert/);
    assert.doesNotMatch(page.body, /<img/i);
  } finally {
    await demo.close();
  }
});

test("mission won is only shown when the scenario reports won", async () => {
  const demo = await serve();
  try {
    for (const status of ["running", "lost", "unknown"] as MissionStatus[]) {
      demo.state.setMission(status, "scenario");
      const page = await demo.get("/");
      assert.equal(page.status, 200);
      assert.doesNotMatch(page.body, /mission: won/);
      assert.match(page.body, new RegExp("mission: " + status));
    }

    demo.state.setMission("won", "scenario");
    const won = await demo.get("/");
    assert.match(won.body, /mission: won/);
    assert.match(won.body, /source: scenario/);
  } finally {
    await demo.close();
  }
});

test("stale seats are marked on the page", async () => {
  const demo = await serve();
  try {
    demo.state.observe("helms", { mode: "HUMAN", observedAt: NOW - 10_000 });
    const page = await demo.get("/");
    assert.equal(page.status, 200);
    assert.match(page.body, /seat--stale/);
    assert.match(page.body, /10\.0s stale/);
  } finally {
    await demo.close();
  }
});