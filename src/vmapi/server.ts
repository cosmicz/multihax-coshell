import { createHash, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { RoleScopedGateway } from "../gateway/gateway.ts";
import { INTENT_NAMES, classifyIntent, validateIntentArgs } from "../gateway/intents.ts";
import type { IntentName } from "../gateway/intents.ts";
import { renderLua } from "../gateway/lua.ts";
import { CALLSIGN_PATTERN } from "../gateway/lua.ts";
import type { GatewayEvent, SeatRole, SeatView } from "../gateway/types.ts";
import {
  DEFAULT_EE_HTTP_PORT,
  DEFAULT_EE_TIMEOUT_MS,
  EeExecLuaPort,
  FIXED_ACTOR_IDS,
  hasLuaField,
  isLoopbackHost,
  isVmCommandRole,
} from "../real/eeport.ts";
import { ENGINEERING_ACTOR_ID, HELM_ACTOR_ID, WEAPONS_ACTOR_ID } from "../real/agents.ts";
import { buildObservationLua, observeOnce } from "../real/observe.ts";
import type { Observation } from "../real/observe.ts";

export const DEFAULT_VMAPI_PORT = 8790;
export const DEFAULT_VMAPI_HOST = "127.0.0.1";
export const MAX_BODY_BYTES = 8 * 1024;
export const DEFAULT_VM_EPOCH = 1;
export const AUTHORIZATION_PREFIX = "bearer ";

export type VmApiOptions = {
  host: string;
  port: number;
  token: string;
  eeHost: string;
  eePort: number;
  eeTimeoutMs: number;
  shipCallsign: string;
  epoch: number;
};

export type CommandBody = {
  role: SeatRole;
  actor_id: string;
  request_id: string;
  intent: IntentName;
  args: Record<string, unknown>;
  generation?: number;
};

export type VmState = {
  options: VmApiOptions;
  port: EeExecLuaPort;
  gateway: RoleScopedGateway;
  ship: string;
  startedAt: number;
  observationSeq: number;
  lastObservationAt: string | null;
  lastObservationCode: string | null;
  gatewayEvents: Record<string, number>;
  commands: Record<string, number>;
};

export type BodyResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; status: number; error: string; detail: string };

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function strEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  return raw.trim();
}

export function parseEngineHttp(raw: string): { host: string; port: number } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`EE_HTTP is not a url: ${raw}`);
  }
  if (url.protocol !== "http:") {
    throw new TypeError(`EE_HTTP must be plain http on loopback: ${raw}`);
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new TypeError(`EE_HTTP host must be 127.0.0.1 or localhost: ${raw}`);
  }
  const port = url.port.length > 0 ? Number(url.port) : DEFAULT_EE_HTTP_PORT;
  return { host: url.hostname, port };
}

export function loadVmApiOptions(): VmApiOptions {
  const token = strEnv("VMAPI_TOKEN", "");
  if (token.length === 0) {
    throw new TypeError("VMAPI_TOKEN is required; refusing to start the vm api without it");
  }
  if (token.length < 16) {
    throw new TypeError("VMAPI_TOKEN must be at least 16 characters");
  }
  const engine = parseEngineHttp(strEnv("EE_HTTP", "http://127.0.0.1:8080"));
  const ship = strEnv("SHIP_CALLSIGN", "");
  if (ship.length === 0) {
    throw new TypeError("SHIP_CALLSIGN is required; there is no first-observation binding");
  }
  if (!CALLSIGN_PATTERN.test(ship)) {
    throw new TypeError(`SHIP_CALLSIGN is not a usable callsign: ${ship}`);
  }
  return {
    host: strEnv("VMAPI_HOST", DEFAULT_VMAPI_HOST),
    port: numEnv("VMAPI_PORT", DEFAULT_VMAPI_PORT),
    token,
    eeHost: engine.host,
    eePort: engine.port,
    eeTimeoutMs: numEnv("EE_TIMEOUT_MS", DEFAULT_EE_TIMEOUT_MS),
    shipCallsign: ship,
    epoch: numEnv("EPOCH", DEFAULT_VM_EPOCH),
  };
}

export function tokensMatch(presented: string, expected: string): boolean {
  const left = createHash("sha256").update(presented, "utf8").digest();
  const right = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(left, right);
}

export function checkAuthorization(
  header: string | undefined,
  token: string,
): boolean {
  if (typeof header !== "string") {
    return false;
  }
  const trimmed = header.trim();
  if (trimmed.length <= AUTHORIZATION_PREFIX.length) {
    return false;
  }
  if (trimmed.slice(0, AUTHORIZATION_PREFIX.length).toLowerCase() !== AUTHORIZATION_PREFIX) {
    return false;
  }
  return tokensMatch(trimmed.slice(AUTHORIZATION_PREFIX.length).trim(), token);
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendError(
  response: ServerResponse,
  status: number,
  error: string,
  detail: string,
): void {
  sendJson(response, status, { ok: false, error, detail });
}

function readJsonBody(request: IncomingMessage): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (result: BodyResult): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish({
          ok: false,
          status: 413,
          error: "BODY_TOO_LARGE",
          detail: `body limit is ${String(MAX_BODY_BYTES)} bytes`,
        });
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("error", () => {
      finish({ ok: false, status: 400, error: "BAD_BODY", detail: "body unreadable" });
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim().length === 0) {
        finish({ ok: false, status: 400, error: "BAD_BODY", detail: "body is empty" });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        finish({
          ok: false,
          status: 400,
          error: "BAD_BODY",
          detail: "body is not valid JSON",
        });
        return;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        finish({
          ok: false,
          status: 400,
          error: "BAD_BODY",
          detail: "body must be a JSON object",
        });
        return;
      }
      finish({ ok: true, value: parsed as Record<string, unknown> });
    });
  });
}

const REFUSED_FIELDS = ["lua", "script", "lua_body", "exec", "body", "chunk"] as const;

export function parseCommandBody(body: Record<string, unknown>): CommandBody | string {
  for (const field of REFUSED_FIELDS) {
    if (Object.keys(body).some((key) => key.toLowerCase() === field)) {
      return `raw lua is never accepted: remove the ${field} field`;
    }
  }
  const role = body["role"];
  if (!isVmCommandRole(role)) {
    return "role must be helms or engineering";
  }
  const actorId = body["actor_id"];
  if (typeof actorId !== "string" || actorId !== FIXED_ACTOR_IDS[role]) {
    return `actor_id must be ${FIXED_ACTOR_IDS[role]} for ${role}`;
  }
  const requestId = body["request_id"];
  if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128) {
    return "request_id must be a string of 1 to 128 characters";
  }
  const intent = body["intent"];
  if (typeof intent !== "string" || !(INTENT_NAMES as readonly string[]).includes(intent)) {
    return `intent is not in the allowlist: ${String(intent)}`;
  }
  const args = body["args"];
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return "args must be a JSON object";
  }
  if (hasLuaField(args as Record<string, unknown>)) {
    return "args must not carry lua text";
  }
  const classified = classifyIntent(intent, role);
  if (!classified.ok) {
    return `intent is not permitted for role ${role}: ${classified.code}`;
  }
  const validated = validateIntentArgs(classified.intent, args);
  if (!validated.ok) {
    return `args rejected for ${intent}: ${validated.code}`;
  }
  const generation = body["generation"];
  const parsed: CommandBody = {
    role,
    actor_id: actorId,
    request_id: requestId,
    intent: intent as IntentName,
    args: args as Record<string, unknown>,
  };
  if (generation !== undefined) {
    if (typeof generation !== "number" || !Number.isInteger(generation)) {
      return "generation must be an integer when present";
    }
    parsed.generation = generation;
  }
  return parsed;
}

function logLine(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function countEvent(
  events: Record<string, number>,
  event: GatewayEvent,
): Record<string, number> {
  events[event.type] = (events[event.type] ?? 0) + 1;
  return events;
}

export function seatViews(state: VmState): SeatView[] {
  const views: SeatView[] = [];
  for (const role of ["helms", "engineering", "weapons"] as const) {
    const view = state.gateway.seat({
      epoch: state.options.epoch,
      ship: state.ship,
      role,
    });
    if (view) {
      views.push(view);
    }
  }
  return views;
}

export function healthPayload(state: VmState): Record<string, unknown> {
  return {
    ok: true,
    ship: state.ship,
    epoch: state.options.epoch,
    observation_seq: state.observationSeq,
    last_observation_at: state.lastObservationAt,
    last_observation_code: state.lastObservationCode,
    uptime_ms: Date.now() - state.startedAt,
    engine: state.port.endpoint,
    fixed_actors: { ...FIXED_ACTOR_IDS },
    seats: seatViews(state),
    gateway_events: state.gatewayEvents,
    commands: state.commands,
  };
}

async function observeFromEngine(
  port: EeExecLuaPort,
  callsign: string,
): Promise<{
  observation: Observation | null;
  seq: number;
  at: string;
  code: string | null;
  detail: string;
}> {
  const tick = await observeOnce(port, callsign);
  const at = new Date(tick.at).toISOString();
  if (!tick.result.ok) {
    return {
      observation: null,
      seq: 0,
      at,
      code: tick.result.code,
      detail: `${tick.result.code}: ${tick.result.detail}`,
    };
  }
  return {
    observation: tick.result.observation,
    seq: 1,
    at,
    code: null,
    detail: "",
  };
}

export function createVmApiServer(state: VmState): Server {
  return createHttpServer((request: IncomingMessage, response: ServerResponse) => {
    const method = request.method ?? "GET";
    let pathname = "/";
    try {
      pathname = new URL(request.url ?? "/", "http://vmapi.invalid").pathname;
    } catch {
      sendError(response, 400, "BAD_REQUEST", "unparsable request url");
      return;
    }
    if (!checkAuthorization(request.headers.authorization, state.options.token)) {
      sendError(
        response,
        401,
        "UNAUTHORIZED",
        "send Authorization: Bearer <VMAPI_TOKEN> with every request",
      );
      return;
    }
    if (method === "GET" && pathname === "/v1/health") {
      sendJson(response, 200, healthPayload(state));
      return;
    }
    if (method === "GET" && pathname === "/v1/observe") {
      void observeFromEngine(state.port, state.ship).then((outcome) => {
        state.lastObservationAt = outcome.at;
        state.lastObservationCode = outcome.code;
        if (outcome.observation === null) {
          sendJson(response, 502, {
            ok: false,
            code: outcome.code ?? "PORT_ERROR",
            detail: outcome.detail,
            observation_seq: state.observationSeq,
          });
          return;
        }
        state.observationSeq += 1;
        sendJson(response, 200, {
          ok: true,
          at: outcome.at,
          observation_seq: state.observationSeq,
          ship: state.ship,
          observation: outcome.observation,
        });
      })
      .catch((error: unknown) => {
        sendJson(response, 502, {
          ok: false,
          code: "PORT_ERROR",
          detail: error instanceof Error ? error.message : String(error),
          observation_seq: state.observationSeq,
        });
      });
      return;
    }
    if (pathname === "/v1/command") {
      if (method !== "POST") {
        sendError(response, 405, "METHOD_NOT_ALLOWED", "use POST");
        return;
      }
      void readJsonBody(request).then((body) => {
        if (!body.ok) {
          sendError(response, body.status, body.error, body.detail);
          return;
        }
        const parsed = parseCommandBody(body.value);
        if (typeof parsed === "string") {
          sendError(response, 400, "INVALID_COMMAND", parsed);
          return;
        }
        const seat = state.gateway.seat({
          epoch: state.options.epoch,
          ship: state.ship,
          role: parsed.role,
        });
        const generation = parsed.generation ?? seat?.generation ?? 0;
        const seq = state.observationSeq;
        void state.gateway
          .submit({
            epoch: state.options.epoch,
            ship: state.ship,
            role: parsed.role,
            actor_id: parsed.actor_id,
            generation,
            request_id: parsed.request_id,
            observation_seq: seq,
            intent: parsed.intent,
            args: parsed.args,
          })
          .then((result) => {
            const key = `${result.outcome}:${"code" in result ? result.code : ""}`;
            state.commands[key] = (state.commands[key] ?? 0) + 1;
            const status =
              result.outcome === "accepted"
                ? 200
                : result.outcome === "refused"
                  ? 409
                  : result.outcome === "timeout"
                    ? 504
                    : 502;
            logLine({
              at: new Date().toISOString(),
              kind: "command",
              role: parsed.role,
              actor_id: parsed.actor_id,
              request_id: parsed.request_id,
              intent: parsed.intent,
              outcome: result.outcome,
              code: "code" in result ? result.code : null,
              reason: "reason" in result ? result.reason : null,
              observation_seq: seq,
              generation,
            });
            sendJson(response, status, { ok: result.outcome === "accepted", result });
          })
          .catch((error: unknown) => {
            const detail = error instanceof Error ? error.message : String(error);
            state.commands["error:"] = (state.commands["error:"] ?? 0) + 1;
            logLine({
              at: new Date().toISOString(),
              kind: "command_error",
              role: parsed.role,
              request_id: parsed.request_id,
              detail,
            });
            sendJson(response, 502, { ok: false, error: "COMMAND_FAILED", detail });
          });
      });
      return;
    }
    sendError(response, 404, "NOT_FOUND", `no route for ${pathname}`);
  });
}

const INTENT_EXAMPLES: ReadonlyArray<{
  intent: IntentName;
  role: SeatRole;
  args: Record<string, unknown>;
}> = [
  { intent: "heading_degrees", role: "helms", args: { heading_degrees: 90 } },
  { intent: "impulse_fraction", role: "helms", args: { impulse_fraction: 0.5 } },
  {
    intent: "system_power_request",
    role: "engineering",
    args: { system: "impulse", level: 1.2 },
  },
  {
    intent: "system_coolant_request",
    role: "engineering",
    args: { system: "impulse", level: 2 },
  },
  {
    intent: "target_ship",
    role: "weapons",
    args: { callsign: "Crusader Naa'Tvek" },
  },
  {
    intent: "load_tube",
    role: "weapons",
    args: { tube: 0, weapon: "Homing" },
  },
  {
    intent: "fire_tube",
    role: "weapons",
    args: { tube: 0, callsign: "Crusader Naa'Tvek" },
  },
  { intent: "set_shields", role: "weapons", args: { active: true } },
  { intent: "set_beam_frequency", role: "weapons", args: { frequency: 10 } },
  { intent: "set_auto_repair", role: "engineering", args: { enabled: true } },
  { intent: "combat_boost", role: "helms", args: { amount: 0.5 } },
  { intent: "combat_strafe", role: "helms", args: { amount: -0.5 } },
  { intent: "unload_tube", role: "weapons", args: { tube: 0 } },
  { intent: "set_shield_frequency", role: "weapons", args: { frequency: 10 } },
  { intent: "set_beam_system_target", role: "weapons", args: { system: "reactor" } },
  {
    intent: "fire_tube_heading",
    role: "weapons",
    args: { tube: 0, heading_degrees: 90 },
  },
  {
    intent: "assign_repair_crew",
    role: "engineering",
    args: { crew: 1, system: "reactor" },
  },
];

export function printScripts(callsign: string, enemyCallsign: string): string {
  const sections: string[] = [];
  sections.push(
    "== observation (built for the bound callsign, POSTed verbatim to loopback /exec.lua) ==",
    buildObservationLua(callsign),
  );
  sections.push(`== command templates for callsign ${callsign} ==`);
  for (const example of INTENT_EXAMPLES) {
    const validated = validateIntentArgs(example.intent, example.args);
    if (!validated.ok) {
      throw new Error(`example args for ${example.intent} are rejected: ${validated.code}`);
    }
    sections.push(
      `-- intent: ${example.intent} role: ${example.role} args: ${JSON.stringify(example.args)}`,
      renderLua({ callsign, role: example.role, intent: validated.intent }),
    );
  }
  sections.push(`== intent count: ${String(INTENT_NAMES.length)} ==`);
  sections.push(
    `== weapons example needs an enemy player ship; ENEMY_CALLSIGN=${enemyCallsign} ==`,
  );
  return sections.join("\n\n");
}

export async function startVmApi(options: VmApiOptions): Promise<{ state: VmState; server: Server }> {
  const port = new EeExecLuaPort({
    host: options.eeHost,
    port: options.eePort,
    timeout_ms: options.eeTimeoutMs,
  });
  const bound = {
    callsign: options.shipCallsign,
    observationSeq: 0,
    lastObservationAt: null as string | null,
  };
  logLine({
    at: new Date().toISOString(),
    kind: "bind",
    callsign: bound.callsign,
    source: "SHIP_CALLSIGN",
  });
  const gatewayEvents: Record<string, number> = {};
  const gateway = new RoleScopedGateway(
    {
      ship: bound.callsign,
      epoch: options.epoch,
      timeout_ms: options.eeTimeoutMs + 500,
      on_event: (event: GatewayEvent) => {
        countEvent(gatewayEvents, event);
      },
    },
    port,
  );
  for (const [role, actorId] of [
    ["helms", HELM_ACTOR_ID],
    ["engineering", ENGINEERING_ACTOR_ID],
    ["weapons", WEAPONS_ACTOR_ID],
  ] as const) {
    const claim = gateway.claimAgent({ epoch: options.epoch, ship: bound.callsign, role }, actorId);
    if (!claim.ok) {
      throw new Error(`seat claim for ${actorId} failed: ${claim.code}`);
    }
    logLine({
      at: new Date().toISOString(),
      kind: "claim",
      agent: actorId,
      role,
      generation: claim.seat.generation,
    });
  }
  const state: VmState = {
    options,
    port,
    gateway,
    ship: bound.callsign,
    startedAt: Date.now(),
    observationSeq: bound.observationSeq,
    lastObservationAt: bound.lastObservationAt,
    lastObservationCode: null,
    gatewayEvents,
    commands: {},
  };
  const server = createVmApiServer(state);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const boundPort =
    typeof address === "object" && address !== null ? address.port : options.port;
  logLine({
    at: new Date().toISOString(),
    kind: "listening",
    url: `http://${options.host}:${String(boundPort)}`,
    engine: port.endpoint,
    ship: state.ship,
    epoch: options.epoch,
    actors: { ...FIXED_ACTOR_IDS },
  });
  return { state, server };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--print-scripts")) {
    const options = loadVmApiOptions();
    process.stdout.write(
      `${printScripts(options.shipCallsign, strEnv("ENEMY_CALLSIGN", "Crusader Naa'Tvek"))}\n`,
    );
    return;
  }
  const options = loadVmApiOptions();
  const { server } = await startVmApi(options);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      server.close(() => {
        process.exit(0);
      });
    });
  }
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("vmapi/server.ts") || entry.endsWith("vmapi/server.js")) {
  main().catch((error: unknown) => {
    logLine({
      at: new Date().toISOString(),
      kind: "fatal",
      detail: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
    const flush = setTimeout(() => {
      process.exit(1);
    }, 250);
    if (typeof flush.unref === "function") flush.unref();
  });
}