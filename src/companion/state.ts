import { ORDER_TEXT_MAX, ROLES, STALE_AFTER_MS, APP_LEVEL_ROLE, isRole } from "./types.ts";
import type {
  CompanionState,
  ControllerMode,
  MissionSnapshot,
  MissionSource,
  MissionStatus,
  NativeOccupancy,
  Observation,
  Order,
  Role,
  SeatSnapshot,
  ShipInfo,
  StateSnapshot,
  TimelineEntry,
} from "./types.ts";

export type OrderValidationFailure = {
  ok: false;
  reason: "BAD_BODY" | "BAD_ROLE" | "BAD_TEXT";
  detail: string;
};

export type OrderValidationSuccess = {
  ok: true;
  to_role: Role;
  text: string;
};

export type OrderValidation = OrderValidationFailure | OrderValidationSuccess;

export function validateOrderInput(body: unknown): OrderValidation {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, reason: "BAD_BODY", detail: "body must be a JSON object" };
  }
  const record = body as Record<string, unknown>;
  const toRole = record["to_role"];
  if (!isRole(toRole)) {
    return {
      ok: false,
      reason: "BAD_ROLE",
      detail: "to_role must be one of: " + ROLES.join(", "),
    };
  }
  const rawText = record["text"];
  if (typeof rawText !== "string") {
    return { ok: false, reason: "BAD_TEXT", detail: "text must be a string" };
  }
  const text = rawText.trim();
  if (text.length < 1) {
    return { ok: false, reason: "BAD_TEXT", detail: "text must not be empty" };
  }
  if (text.length > ORDER_TEXT_MAX) {
    return {
      ok: false,
      reason: "BAD_TEXT",
      detail: "text must be at most " + String(ORDER_TEXT_MAX) + " characters",
    };
  }
  return { ok: true, to_role: toRole, text };
}

export interface ObservationPatch {
  mode?: ControllerMode;
  generation?: number;
  observedAt?: number;
}

export interface MemoryStateOptions {
  ship: ShipInfo;
  epoch?: number;
  clock?: () => number;
  mission?: MissionSnapshot;
  observations?: Observation[];
  occupancy?: Partial<Record<Role, NativeOccupancy>>;
  timelineLimit?: number;
}

const DEFAULT_TIMELINE_LIMIT = 200;

export class MemoryState implements CompanionState {
  private readonly shipInfo: ShipInfo;
  private readonly clock: () => number;
  private readonly timelineLimit: number;
  private readonly observed = new Map<Role, Observation>();
  private readonly occupancy = new Map<Role, NativeOccupancy>();
  private readonly inboxes = new Map<Role, Order[]>();
  private readonly entries: TimelineEntry[] = [];
  private currentEpoch: number;
  private missionStatus: MissionStatus;
  private missionSource: MissionSource;
  private sequence = 0;

  constructor(options: MemoryStateOptions) {
    this.shipInfo = { ...options.ship };
    this.clock = options.clock ?? (() => Date.now());
    this.timelineLimit = options.timelineLimit ?? DEFAULT_TIMELINE_LIMIT;
    this.currentEpoch = options.epoch ?? 1;
    this.missionStatus = options.mission?.status ?? "unknown";
    this.missionSource = options.mission?.source ?? "unknown";

    for (const role of ROLES) {
      this.inboxes.set(role, []);
    }

    const seeded = options.observations ?? defaultObservations(this.clock());
    for (const observation of seeded) {
      this.observed.set(observation.role, { ...observation });
    }

    for (const role of ROLES) {
      const occupancy = options.occupancy?.[role];
      this.occupancy.set(role, occupancy ?? "vacant");
    }
  }

  ship(): ShipInfo {
    return { ...this.shipInfo };
  }

  epoch(): number {
    return this.currentEpoch;
  }

  setEpoch(epoch: number): void {
    this.currentEpoch = epoch;
  }

  setMission(status: MissionStatus, source: MissionSource = "scenario"): void {
    this.missionStatus = status;
    this.missionSource = source;
  }

  generationOf(role: Role): number {
    return this.observed.get(role)?.generation ?? 0;
  }

  modeOf(role: Role): ControllerMode {
    return this.observed.get(role)?.mode ?? "PAUSED";
  }

  observe(role: Role, patch: ObservationPatch = {}): Observation {
    const current = this.observed.get(role);
    const nextMode = patch.mode ?? current?.mode ?? "PAUSED";
    const generation =
      patch.generation ?? (current && current.mode === nextMode ? current.generation : (current?.generation ?? 0) + 1);
    const observation: Observation = {
      role,
      observedAt: patch.observedAt ?? this.clock(),
      generation,
      mode: nextMode,
    };
    this.observed.set(role, observation);
    return { ...observation };
  }

  touch(role: Role, observedAt?: number): Observation {
    return this.observe(role, observedAt === undefined ? {} : { observedAt });
  }

  setNativeOccupancy(role: Role, occupancy: NativeOccupancy): void {
    this.occupancy.set(role, occupancy);
  }

  inbox(role: Role): Order[] {
    return (this.inboxes.get(role) ?? []).map((order) => ({ ...order }));
  }

  postOrder(order: Order): Order {
    const inbox = this.inboxes.get(order.to_role);
    if (!inbox) {
      throw new Error("unknown role: " + String(order.to_role));
    }
    inbox.push({ ...order });
    this.note({
      id: this.nextId("tl"),
      epoch: this.currentEpoch,
      at: order.at,
      kind: "order",
      role: order.to_role,
      text: order.text,
    });
    return { ...order };
  }

  note(entry: TimelineEntry): TimelineEntry {
    this.entries.push({ ...entry });
    if (this.entries.length > this.timelineLimit) {
      this.entries.splice(0, this.entries.length - this.timelineLimit);
    }
    return { ...entry };
  }

  nextId(prefix: string): string {
    this.sequence += 1;
    return prefix + "-" + String(this.sequence);
  }

  snapshot(): StateSnapshot {
    const now = this.clock();
    const seats: SeatSnapshot[] = ROLES.map((role) => {
      const observation = this.observed.get(role);
      const observedAt = observation?.observedAt ?? 0;
      const age = now - observedAt;
      return {
        role,
        kind: role === APP_LEVEL_ROLE ? "app" : "station",
        native_occupancy: this.occupancy.get(role) ?? "vacant",
        mode: observation?.mode ?? "PAUSED",
        generation: observation?.generation ?? 0,
        observed_at: observedAt,
        age_ms: age,
        stale: age > STALE_AFTER_MS,
      };
    });

    return {
      epoch: this.currentEpoch,
      ship: this.ship(),
      seats,
      timeline: this.entries.map((entry) => ({ ...entry })),
      mission: { status: this.missionStatus, source: this.missionSource },
    };
  }
}

function defaultObservations(now: number): Observation[] {
  return ROLES.map((role) => ({
    role,
    observedAt: now,
    generation: 1,
    mode: "PAUSED" as ControllerMode,
  }));
}