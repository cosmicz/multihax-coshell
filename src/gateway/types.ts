export const SEAT_ROLES = ["helms", "engineering"] as const;
export type SeatRole = (typeof SEAT_ROLES)[number];

export const SEAT_MODES = ["HUMAN", "AGENT", "PAUSED"] as const;
export type SeatMode = (typeof SEAT_MODES)[number];

export const REFUSAL_CODES = [
  "UNKNOWN_INTENT",
  "WRONG_ROLE",
  "NOT_LEASEHOLDER",
  "STALE_GENERATION",
  "EPOCH_MISMATCH",
  "STALE_OBSERVATION",
  "SEAT_NOT_AGENT",
  "OUT_OF_RANGE",
  "DUPLICATE_MISMATCH",
  "OCCUPIED",
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

const ROLE_SET: ReadonlySet<string> = new Set<string>(SEAT_ROLES);

export function isSeatRole(value: unknown): value is SeatRole {
  return typeof value === "string" && ROLE_SET.has(value);
}

export type ExecResponse = {
  status: number;
  body: string;
};

export interface WorldPort {
  execLua(script: string): Promise<ExecResponse>;
}

export type SeatKey = {
  epoch: number;
  ship: string;
  role: SeatRole;
};

export function seatKeyId(key: SeatKey): string {
  return `${key.epoch}:${key.ship}:${key.role}`;
}

export type SeatView = {
  id: string;
  epoch: number;
  ship: string;
  role: SeatRole;
  mode: SeatMode;
  generation: number;
  leaseholder: string | null;
  native_vacant: boolean;
  human_latched: boolean;
  last_observation_seq: number;
};

export type WireEnvelope = {
  epoch: number;
  ship: string;
  role: string;
  actor_id: string;
  generation: number;
  request_id: string;
  observation_seq: number;
  intent: string;
  args: Record<string, unknown>;
};

export const FAILURE_REASONS = [
  "http_error",
  "upstream_error",
  "invalid_json",
  "unexpected_body",
  "port_error",
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export type AcceptedResult = {
  outcome: "accepted";
  stage: "accepted" | "upstream_receipt";
  request_id: string;
  seat: string;
  generation: number;
  intent: string;
  lua: string;
  receipt?: Record<string, unknown>;
};

export type RefusedResult = {
  outcome: "refused";
  request_id: string;
  code: RefusalCode;
  detail: string;
  seat: string | null;
};

export type FailedResult = {
  outcome: "failed";
  request_id: string;
  seat: string;
  generation: number;
  intent: string;
  lua: string;
  reason: FailureReason;
  status: number;
  body: string;
};

export type TimeoutResult = {
  outcome: "timeout";
  request_id: string;
  seat: string;
  generation: number;
  intent: string;
  lua: string;
  timeout_ms: number;
};

export type GatewayResult =
  | AcceptedResult
  | RefusedResult
  | FailedResult
  | TimeoutResult;

export type GatewayEvent =
  | {
      type: "accepted";
      request_id: string;
      seat: string;
      generation: number;
      intent: string;
      lua: string;
    }
  | {
      type: "upstream_receipt";
      request_id: string;
      receipt: Record<string, unknown>;
    }
  | { type: "refused"; request_id: string; code: RefusalCode }
  | {
      type: "failed";
      request_id: string;
      reason: FailureReason;
      status: number;
    }
  | { type: "timeout"; request_id: string; timeout_ms: number };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}