import {
  SEAT_ROLES,
  seatKeyId,
  type RefusalCode,
  type SeatKey,
  type SeatMode,
  type SeatRole,
  type SeatView,
} from "./types.ts";

type SeatRecord = {
  key: SeatKey;
  mode: SeatMode;
  generation: number;
  leaseholder: string | null;
  native_vacant: boolean;
  human_latched: boolean;
  last_observation_seq: number;
};

export type ControlResult =
  | { ok: true; seat: SeatView }
  | { ok: false; code: RefusalCode };

function snapshot(record: SeatRecord): SeatView {
  return {
    id: seatKeyId(record.key),
    epoch: record.key.epoch,
    ship: record.key.ship,
    role: record.key.role,
    mode: record.mode,
    generation: record.generation,
    leaseholder: record.leaseholder,
    native_vacant: record.native_vacant,
    human_latched: record.human_latched,
    last_observation_seq: record.last_observation_seq,
  };
}

export class SeatRegistry {
  private readonly seats = new Map<string, SeatRecord>();

  register(key: SeatKey): SeatView {
    const id = seatKeyId(key);
    const existing = this.seats.get(id);
    if (existing) return snapshot(existing);
    const record: SeatRecord = {
      key,
      mode: "PAUSED",
      generation: 0,
      leaseholder: null,
      native_vacant: true,
      human_latched: false,
      last_observation_seq: Number.NEGATIVE_INFINITY,
    };
    this.seats.set(id, record);
    return snapshot(record);
  }

  view(key: SeatKey): SeatView | null {
    const record = this.seats.get(seatKeyId(key));
    return record ? snapshot(record) : null;
  }

  private record(key: SeatKey): SeatRecord | undefined {
    return this.seats.get(seatKeyId(key));
  }

  claimAgent(key: SeatKey, actorId: string): ControlResult {
    const record = this.record(key);
    if (!record) return { ok: false, code: "NOT_LEASEHOLDER" };
    if (record.human_latched) return { ok: false, code: "OCCUPIED" };
    if (typeof actorId !== "string" || actorId.length === 0) {
      return { ok: false, code: "NOT_LEASEHOLDER" };
    }
    record.mode = "AGENT";
    record.leaseholder = actorId;
    return { ok: true, seat: snapshot(record) };
  }

  markHumanOccupied(key: SeatKey): ControlResult {
    const record = this.record(key);
    if (!record) return { ok: false, code: "NOT_LEASEHOLDER" };
    record.mode = "HUMAN";
    record.human_latched = true;
    record.native_vacant = false;
    record.generation += 1;
    return { ok: true, seat: snapshot(record) };
  }

  resume(key: SeatKey, actorId: string): ControlResult {
    const record = this.record(key);
    if (!record) return { ok: false, code: "NOT_LEASEHOLDER" };
    if (!record.native_vacant) return { ok: false, code: "OCCUPIED" };
    if (typeof actorId !== "string" || actorId.length === 0) {
      return { ok: false, code: "NOT_LEASEHOLDER" };
    }
    record.mode = "AGENT";
    record.human_latched = false;
    record.leaseholder = actorId;
    record.generation += 1;
    return { ok: true, seat: snapshot(record) };
  }

  pause(key: SeatKey): ControlResult {
    const record = this.record(key);
    if (!record) return { ok: false, code: "NOT_LEASEHOLDER" };
    record.mode = "PAUSED";
    record.generation += 1;
    return { ok: true, seat: snapshot(record) };
  }

  reportNativeVacancy(key: SeatKey, vacant: boolean): ControlResult {
    const record = this.record(key);
    if (!record) return { ok: false, code: "NOT_LEASEHOLDER" };
    record.native_vacant = vacant;
    return { ok: true, seat: snapshot(record) };
  }

  latchOccupied(key: SeatKey): ControlResult {
    return this.markHumanOccupied(key);
  }

  isAgentLease(id: string, actorId: string, generation: number): boolean {
    const record = this.seats.get(id);
    if (!record) return false;
    return (
      record.mode === "AGENT" &&
      record.leaseholder === actorId &&
      record.generation === generation
    );
  }

  recordObservation(key: SeatKey, seq: number): void {
    const record = this.record(key);
    if (!record) return;
    if (Number.isFinite(seq) && seq > record.last_observation_seq) {
      record.last_observation_seq = seq;
    }
  }

  observationAccepted(key: SeatKey, seq: unknown): boolean {
    const record = this.record(key);
    if (!record) return false;
    return (
      Number.isInteger(seq) && (seq as number) >= record.last_observation_seq
    );
  }

  roles(): readonly SeatRole[] {
    return SEAT_ROLES;
  }
}