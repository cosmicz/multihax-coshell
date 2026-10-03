import { MemoryState } from "./state.ts";
import type { MemoryStateOptions } from "./state.ts";
import { ROLES } from "./types.ts";
import type {
  Controller,
  ControllerMode,
  NativeOccupancy,
  Observation,
  PauseResult,
  Role,
  ShipInfo,
} from "./types.ts";

export interface MemoryControllerOptions {
  state: MemoryState;
  occupancy?: Partial<Record<Role, NativeOccupancy>>;
}

interface ControllerSeat {
  occupancy: NativeOccupancy;
  paused: boolean;
}

export class MemoryController implements Controller {
  private readonly state: MemoryState;
  private readonly seats = new Map<Role, ControllerSeat>();

  constructor(options: MemoryControllerOptions) {
    this.state = options.state;
    for (const role of ROLES) {
      const occupancy = options.occupancy?.[role] ?? "vacant";
      const seat: ControllerSeat = { occupancy, paused: false };
      this.seats.set(role, seat);
      this.state.setNativeOccupancy(role, occupancy);
    }
  }

  occupancy(role: Role): NativeOccupancy {
    return this.seats.get(role)?.occupancy ?? "vacant";
  }

  setOccupancy(role: Role, occupancy: NativeOccupancy): void {
    const seat = this.seats.get(role);
    if (!seat) {
      return;
    }
    seat.occupancy = occupancy;
    this.state.setNativeOccupancy(role, occupancy);
    // HUMAN is only ever reported while the native seat is occupied. When the
    // native player leaves, the seat falls back to PAUSED: an agent never takes
    // over on its own, only an explicit resume() hands the seat to an agent.
    if (occupancy === "occupied") {
      this.state.observe(role, { mode: "HUMAN" });
      return;
    }
    if (this.state.modeOf(role) === "HUMAN") {
      seat.paused = true;
      this.state.observe(role, { mode: "PAUSED" });
    }
  }

  paused(role: Role): boolean {
    return this.seats.get(role)?.paused ?? false;
  }

  pause(role: Role): PauseResult {
    const seat = this.seats.get(role);
    if (!seat) {
      return { ok: false, reason: "OCCUPIED", detail: "unknown seat: " + String(role) };
    }
    if (seat.occupancy === "occupied") {
      return {
        ok: false,
        reason: "OCCUPIED",
        detail: role + " is occupied by a native player",
      };
    }
    seat.paused = true;
    this.state.observe(role, { mode: "PAUSED" });
    return { ok: true, role, mode: "PAUSED", generation: this.state.generationOf(role) };
  }

  resume(role: Role): PauseResult {
    const seat = this.seats.get(role);
    if (!seat) {
      return { ok: false, reason: "OCCUPIED", detail: "unknown seat: " + String(role) };
    }
    if (seat.occupancy === "occupied") {
      return {
        ok: false,
        reason: "OCCUPIED",
        detail: role + " is occupied by a native player",
      };
    }
    seat.paused = false;
    this.state.observe(role, { mode: "AGENT" });
    return { ok: true, role, mode: "AGENT", generation: this.state.generationOf(role) };
  }
}

export interface FakeCompanionOptions {
  ship?: ShipInfo;
  epoch?: number;
  clock?: () => number;
  mission?: { status: "running" | "won" | "lost" | "unknown"; source: "scenario" | "unknown" };
  occupancy?: Partial<Record<Role, NativeOccupancy>>;
  modes?: Partial<Record<Role, ControllerMode>>;
}

export interface FakeCompanion {
  state: MemoryState;
  controller: MemoryController;
}

export function createFakeCompanion(options: FakeCompanionOptions = {}): FakeCompanion {
  const clock = options.clock ?? (() => Date.now());
  const now = clock();
  const occupancy: Partial<Record<Role, NativeOccupancy>> = {
    helms: "occupied",
    ...options.occupancy,
  };
  const modes: Partial<Record<Role, ControllerMode>> = options.modes ?? {};

  // An occupied native seat is reported as HUMAN; every other seat starts PAUSED
  // until it is resumed, which hands it to an agent.
  const observations: Observation[] = ROLES.map((role) => ({
    role,
    observedAt: now,
    generation: 1,
    mode: modes[role] ?? (occupancy[role] === "occupied" ? "HUMAN" : "PAUSED"),
  }));

  const stateOptions: MemoryStateOptions = {
    ship: options.ship ?? { name: "Horizon", type: "destroyer" },
    clock,
    observations,
  };
  if (options.epoch !== undefined) {
    stateOptions.epoch = options.epoch;
  }
  if (options.mission !== undefined) {
    stateOptions.mission = options.mission;
  }

  const state = new MemoryState(stateOptions);
  const controller = new MemoryController({ state, occupancy });
  return { state, controller };
}