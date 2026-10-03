import { createFakeWorldPort, OK, type FakePlan, type FakeWorldPort } from "./fake_port.ts";
import { RoleScopedGateway } from "./gateway.ts";
import type {
  GatewayEvent,
  SeatKey,
  SeatRole,
  WireEnvelope,
  WorldPort,
} from "./types.ts";

export const EPOCH = 7;
export const CALLSIGN = "HORIZON";
export const ACTOR = "agent:hue";

export type HarnessOptions = {
  plans?: FakePlan[];
  fallback?: FakePlan;
  timeout_ms?: number;
  claims?: readonly SeatRole[];
  actor?: string;
  port?: WorldPort;
};

export type GatewayHarness = {
  gateway: RoleScopedGateway;
  port: FakeWorldPort;
  events: GatewayEvent[];
  key: (role?: SeatRole) => SeatKey;
  generation: (role?: SeatRole) => number;
  envelope: (overrides?: Partial<WireEnvelope>) => WireEnvelope;
  eventTypes: () => string[];
};

export function createGatewayHarness(options: HarnessOptions = {}): GatewayHarness {
  const port =
    options.port ?? createFakeWorldPort(options.plans ?? [], options.fallback ?? OK);
  const events: GatewayEvent[] = [];
  const gateway = new RoleScopedGateway(
    {
      ship: CALLSIGN,
      epoch: EPOCH,
      timeout_ms: options.timeout_ms ?? 50,
      on_event: (event: GatewayEvent) => {
        events.push(event);
      },
    },
    port,
  );
  const actor = options.actor ?? ACTOR;
  for (const role of options.claims ?? (["helms", "engineering"] as const)) {
    const claim = gateway.claimAgent({ epoch: EPOCH, ship: CALLSIGN, role }, actor);
    if (!claim.ok) {
      throw new Error(`harness claim failed: ${claim.code}`);
    }
  }
  const observations: Record<SeatRole, number> = { helms: 0, engineering: 0 };
  let requests = 0;
  const key = (role: SeatRole = "helms"): SeatKey => ({
    epoch: EPOCH,
    ship: CALLSIGN,
    role,
  });
  const generation = (role: SeatRole = "helms"): number =>
    gateway.seat(key(role))?.generation ?? -1;
  const envelope = (overrides: Partial<WireEnvelope> = {}): WireEnvelope => {
    const role = (overrides.role as SeatRole | undefined) ?? "helms";
    if (overrides.observation_seq === undefined) {
      observations[role] += 1;
      overrides.observation_seq = observations[role];
    }
    requests += 1;
    return {
      epoch: EPOCH,
      ship: CALLSIGN,
      role,
      actor_id: actor,
      generation: overrides.generation ?? generation(role),
      request_id: overrides.request_id ?? `req-${requests}`,
      observation_seq: overrides.observation_seq,
      intent: "impulse_fraction",
      args: { impulse_fraction: 0.5 },
      ...overrides,
    };
  };
  return {
    gateway,
    port,
    events,
    key,
    generation,
    envelope,
    eventTypes: () => events.map((event) => event.type),
  };
}

export function tick(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}