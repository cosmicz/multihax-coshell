import { createFakeCompanion } from "./fake.ts";
import { createServer } from "./server.ts";
import { STATION_ROLES } from "./types.ts";
import type { Role } from "./types.ts";

export const DEFAULT_PORT = 8080;

export interface DemoOptions {
  port?: number;
  heartbeatMs?: number;
}

export interface DemoCompanion {
  port: number;
  close: () => Promise<void>;
}

export function startDemoCompanion(options: DemoOptions = {}): Promise<DemoCompanion> {
  const requestedPort = options.port ?? DEFAULT_PORT;
  const heartbeatMs = options.heartbeatMs ?? 2000;

  const { state, controller } = createFakeCompanion({
    ship: { name: "Horizon", type: "destroyer" },
    occupancy: { helms: "occupied", engineering: "vacant" },
    modes: { helms: "HUMAN", engineering: "AGENT", weapons: "PAUSED" },
    mission: { status: "running", source: "scenario" },
  });

  state.note({
    id: state.nextId("tl"),
    epoch: state.epoch(),
    at: Date.now(),
    kind: "note",
    role: null,
    text: "companion demo started; helm and engineering are flown in the native EmptyEpsilon client",
  });

  const server = createServer({ state, controller });

  // Heartbeats keep seats fresh. science is deliberately left without one so the
  // page shows a stale seat marker in the demo.
  const heartbeat = setInterval(() => {
    for (const role of STATION_ROLES as readonly Role[]) {
      if (role === "science") {
        continue;
      }
      state.touch(role);
    }
  }, heartbeatMs);
  heartbeat.unref();

  return new Promise((resolve) => {
    server.listen(requestedPort, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : requestedPort;
      resolve({
        port,
        close: () =>
          new Promise<void>((closed) => {
            clearInterval(heartbeat);
            server.close(() => {
              closed();
            });
          }),
      });
    });
  });
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("dev.ts") || entry.endsWith("dev.js")) {
  const requested = Number.parseInt(process.env["PORT"] ?? String(DEFAULT_PORT), 10);
  const port = Number.isFinite(requested) ? requested : DEFAULT_PORT;
  void startDemoCompanion({ port }).then((demo) => {
    console.log("companion listening on http://localhost:" + String(demo.port));
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        void demo.close().then(() => {
          process.exit(0);
        });
      });
    }
  });
}