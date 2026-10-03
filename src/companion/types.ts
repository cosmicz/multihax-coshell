export type Role = "captain" | "helms" | "engineering" | "weapons" | "science" | "relay";

export const APP_LEVEL_ROLE: Role = "captain";

export const ROLES: readonly Role[] = [
  "captain",
  "helms",
  "engineering",
  "weapons",
  "science",
  "relay",
] as const;

export type StationRole = Exclude<Role, "captain">;

export const STATION_ROLES: readonly StationRole[] = [
  "helms",
  "engineering",
  "weapons",
  "science",
  "relay",
] as const;

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function isStationRole(value: unknown): value is StationRole {
  return typeof value === "string" && (STATION_ROLES as readonly string[]).includes(value);
}

export type NativeOccupancy = "occupied" | "vacant";

export type ControllerMode = "HUMAN" | "AGENT" | "PAUSED";

export type MissionStatus = "running" | "won" | "lost" | "unknown";

export type MissionSource = "scenario" | "unknown";

export interface ShipInfo {
  name: string;
  type?: string;
}

export interface Observation {
  role: Role;
  observedAt: number;
  generation: number;
  mode: ControllerMode;
}

export interface Order {
  id: string;
  epoch: number;
  at: number;
  from_role: Role;
  to_role: Role;
  text: string;
}

export interface TimelineEntry {
  id: string;
  epoch: number;
  at: number;
  kind: "order" | "note" | "pause" | "resume";
  role: Role | null;
  text: string;
}

export interface SeatSnapshot {
  role: Role;
  kind: "app" | "station";
  native_occupancy: NativeOccupancy;
  mode: ControllerMode;
  generation: number;
  observed_at: number;
  age_ms: number;
  stale: boolean;
}

export interface MissionSnapshot {
  status: MissionStatus;
  source: MissionSource;
}

export interface StateSnapshot {
  epoch: number;
  ship: ShipInfo;
  seats: SeatSnapshot[];
  timeline: TimelineEntry[];
  mission: MissionSnapshot;
}

export interface CompanionState {
  ship(): ShipInfo;
  epoch(): number;
  snapshot(): StateSnapshot;
  inbox(role: Role): Order[];
  postOrder(order: Order): Order;
  note(entry: TimelineEntry): TimelineEntry;
}

export interface PauseRefusal {
  ok: false;
  reason: "OCCUPIED";
  detail: string;
}

export interface PauseAcceptance {
  ok: true;
  role: Role;
  mode: ControllerMode;
  generation: number;
}

export type PauseResult = PauseAcceptance | PauseRefusal;

export interface Controller {
  occupancy(role: Role): NativeOccupancy;
  pause(role: Role): PauseResult;
  resume(role: Role): PauseResult;
}

export const STALE_AFTER_MS = 5000;

export const ORDER_TEXT_MAX = 280;