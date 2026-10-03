import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { classifyIntent, validateIntentArgs } from "../gateway/intents.ts";
import { isRecord, type SeatRole } from "../gateway/types.ts";
import {
  DEFAULT_VMAPI_TIMEOUT_MS,
  DEFAULT_VMAPI_URL,
  FIXED_ACTOR_IDS,
  MAX_INTENTS_PER_MINUTE,
  VmApiPort,
  isLuaFieldKey,
  isVmCommandRole,
  resolveApiToken,
} from "./eeport.ts";
import type { VmCommandRole, VmCommandSummary, VmHealth, VmSeatInfo } from "./eeport.ts";
import {
  CONTROLLER_LABEL,
  DECISION_HISTORY_LIMIT,
  DEFAULT_TARGET_HEADING,
  ENGINEERING_ACTOR_ID,
  EXTERNAL_INTENTS_PER_MINUTE,
  HELM_ACTOR_ID,
  MAX_AGENT_LABEL_LENGTH,
  MAX_INTENTS_PER_MINUTE,
  RateLimiter,
  RoleDecisionLog,
  createEngineeringAgent,
  createHelmAgent,
  mergeRoleDecisions,
  normalizeAgentLabel,
  ownerLabel,
  parseRuleControllers,
  seatFromVmSeats,
} from "./agents.ts";
import type {
  AgentDecision,
  BoundedAgent,
  RoleDecisionRecord,
  Waypoint,
} from "./agents.ts";
import { observationFailure } from "./observe.ts";
import type { Observation, ObservationResult } from "./observe.ts";

export const DEFAULT_SPECTATOR_PORT = 3000;
export const DEFAULT_SPECTATOR_HOST = "127.0.0.1";
export const MAX_BODY_BYTES = 8 * 1024;
export const DEFAULT_LOG_LIMIT = 60;
export const TAGLINE =
  "Live EmptyEpsilon headless server; agents control helm and engineering";

export type DriveOptions = {
  apiUrl: string;
  apiToken: string;
  apiTokenSource: "file" | "environment";
  apiTimeoutMs: number;
  spectatorHost: string;
  spectatorPort: number;
  tickMs: number;
  rateLimit: number;
  ruleControllers: SeatRole[] | null;
  waypoint: Waypoint | null;
  defaultHeading: number;
  logLimit: number;
  expectedShip: string | null;
};

export type ExternalRoleState = {
  requests: number;
  accepted: number;
  refused: number;
  failed: number;
  rate_limited: number;
  last_request_id: string | null;
  last_at: string | null;
  last_agent_label: string | null;
};

export type DecisionLogEntry = AgentDecision & { kind: "deterministic_controller" };

export type ObservationSnapshot = {
  seq: number;
  at: string;
  age_ms: number;
  ok: boolean;
  code: string | null;
  detail: string;
  observation: Observation | null;
};

export type DriveState = {
  options: DriveOptions;
  client: VmApiPort;
  ship: string;
  epoch: number;
  vmSeats: VmSeatInfo[];
  vmHealth: VmHealth | null;
  startedAt: number;
  observationSeq: number;
  observation: ObservationSnapshot;
  agents: { helm: BoundedAgent; engineering: BoundedAgent };
  log: DecisionLogEntry[];
  tick: {
    index: number;
    last_started_at: string | null;
    last_finished_at: string | null;
    last_duration_ms: number | null;
    failures: number;
  };
  external: Record<VmCommandRole, ExternalRoleState>;
  externalLogs: Record<VmCommandRole, RoleDecisionLog>;
  externalLimiters: Record<VmCommandRole, RateLimiter>;
};

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

function optionalNumber(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function loadDriveOptions(): DriveOptions {
  const waypointX = optionalNumber("WAYPOINT_X");
  const waypointY = optionalNumber("WAYPOINT_Y");
  const secret = resolveApiToken(process.env);
  return {
    apiUrl: strEnv("EE_API_URL", DEFAULT_VMAPI_URL),
    apiToken: secret.token,
    apiTokenSource: secret.from,
    apiTimeoutMs: numEnv("EE_API_TIMEOUT_MS", DEFAULT_VMAPI_TIMEOUT_MS),
    spectatorHost: strEnv("SPECTATOR_HOST", DEFAULT_SPECTATOR_HOST),
    spectatorPort: numEnv("PORT", DEFAULT_SPECTATOR_PORT),
    tickMs: numEnv("TICK_MS", 2000),
    rateLimit: numEnv("RATE_LIMIT", MAX_INTENTS_PER_MINUTE),
    ruleControllers: parseRuleControllers(process.env["RULE_CONTROLLERS"]),
    waypoint:
      waypointX !== null && waypointY !== null ? { x: waypointX, y: waypointY } : null,
    defaultHeading: numEnv("HEADING_DEG", DEFAULT_TARGET_HEADING),
    logLimit: numEnv("LOG_LIMIT", DEFAULT_LOG_LIMIT),
    expectedShip: strEnv("SHIP_CALLSIGN", "").length > 0 ? strEnv("SHIP_CALLSIGN", "") : null,
  };
}

export function ruleControllerEnabled(
  options: DriveOptions,
  role: SeatRole,
): boolean {
  return options.ruleControllers !== null && options.ruleControllers.includes(role);
}

function logLine(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function seatLookup(state: DriveState, role: SeatRole): VmSeatInfo | null {
  return seatFromVmSeats(state.vmSeats, role);
}

function agentPayload(state: DriveState, agent: BoundedAgent): Record<string, unknown> {
  const lastIntent = agent.lastIntent;
  const lastResult: VmCommandSummary | null = agent.lastResult;
  return {
    ...agent.status(),
    last_intent: lastIntent
      ? {
          intent: lastIntent.intent,
          args: lastIntent.args,
          request_id: lastIntent.request_id,
          submitted: lastIntent.submitted,
        }
      : null,
    last_result: lastResult,
    seat: seatLookup(state, agent.role),
  };
}

function externalTotals(state: DriveState): Record<string, number> {
  const totals = { requests: 0, accepted: 0, refused: 0, failed: 0, rate_limited: 0 };
  for (const role of ["helms", "engineering"] as const) {
    const entry = state.external[role];
    totals.requests += entry.requests;
    totals.accepted += entry.accepted;
    totals.refused += entry.refused;
    totals.failed += entry.failed;
    totals.rate_limited += entry.rate_limited;
  }
  return totals;
}

function roleAgent(state: DriveState, role: VmCommandRole): BoundedAgent {
  return role === "helms" ? state.agents.helm : state.agents.engineering;
}

export function rolePayload(state: DriveState, role: VmCommandRole): Record<string, unknown> {
  const agent = roleAgent(state, role);
  const limiter = state.externalLimiters[role];
  return {
    role,
    owner: agent.owner,
    rule_controller_enabled: agent.enabled,
    rule_controller: agentPayload(state, agent),
    external: {
      ...state.external[role],
      window_used: limiter.used(),
      rate_limit: limiter.limit,
    },
    decisions: mergeRoleDecisions(
      agent.history.list(),
      state.externalLogs[role].list(),
      DECISION_HISTORY_LIMIT,
    ),
  };
}

export function statePayload(state: DriveState): Record<string, unknown> {
  const now = Date.now();
  const observation: ObservationSnapshot = {
    ...state.observation,
    age_ms: Math.max(0, now - Date.parse(state.observation.at)),
  };
  return {
    ok: true,
    now: new Date(now).toISOString(),
    started_at: new Date(state.startedAt).toISOString(),
    uptime_ms: now - state.startedAt,
    controller_label: CONTROLLER_LABEL,
    ship: state.ship,
    epoch: state.epoch,
    vm: {
      api_url: state.client.baseUrl,
      token_source: state.options.apiTokenSource,
      timeout_ms: state.client.timeoutMs,
      calls: state.client.calls,
      reachable: state.vmHealth?.ok === true,
      detail: state.vmHealth?.detail ?? "",
      observation_seq: state.vmHealth?.observation_seq ?? 0,
      uptime_ms: state.vmHealth?.uptime_ms ?? null,
      seats: state.vmSeats,
      fixed_actors: { ...FIXED_ACTOR_IDS },
    },
    loop: { tick_ms: state.options.tickMs, ...state.tick },
    rule_controllers: {
      raw: process.env["RULE_CONTROLLERS"] ?? "helms,engineering",
      enabled: state.options.ruleControllers ?? [],
      all_off: state.options.ruleControllers === null,
    },
    observation,
    roles: {
      helms: rolePayload(state, "helms"),
      engineering: rolePayload(state, "engineering"),
    },
    agents: {
      [HELM_ACTOR_ID]: agentPayload(state, state.agents.helm),
      [ENGINEERING_ACTOR_ID]: agentPayload(state, state.agents.engineering),
    },
    external_intents: externalTotals(state),
    log: state.log,
  };
}

const PAGE_STYLES = [
  ":root { color-scheme: dark; }",
  "* { box-sizing: border-box; }",
  "body { margin: 0; padding: 1rem; background: #0d1117; color: #d7e0ea;",
  "  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }",
  "h1 { font-size: 1.1rem; margin: 0 0 0.5rem; }",
  ".notice { border: 1px solid #23406b; background: #0f1c2e; color: #9ecbff;",
  "  padding: 0.5rem 0.7rem; border-radius: 6px; margin: 0 0 0.8rem; }",
  ".label { border: 1px solid #4a3a00; background: #221c00; color: #ffd479;",
  "  padding: 0.3rem 0.6rem; border-radius: 999px; display: inline-block; margin: 0 0 0.8rem; }",
  "main { display: grid; gap: 0.8rem; max-width: 96ch; }",
  "section { border: 1px solid #22303f; border-radius: 6px; padding: 0.6rem 0.7rem; background: #111823; }",
  "h2 { font-size: 0.85rem; margin: 0 0 0.4rem; color: #9fb3c8; text-transform: uppercase; letter-spacing: 0.08em; }",
  "table { width: 100%; border-collapse: collapse; }",
  "td, th { text-align: left; padding: 0.2rem 0.4rem; border-bottom: 1px solid #1c2735; }",
  "#telemetry td:first-child { color: #7f93a8; width: 16ch; }",
  "#log { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.15rem; max-height: 22rem; overflow: auto; }",
  "#log li { border-bottom: 1px solid #1c2735; padding: 0.15rem 0; }",
  ".at { color: #6b7d90; }",
  ".agent-helm { color: #d2a8ff; }",
  ".agent-eng { color: #ffa657; }",
  ".accepted { color: #7ee787; }",
  ".refused, .failed { color: #ff9d9d; }",
  ".timeout, .skipped, .partial, .rejected { color: #ffd479; }",
].join("\n");

const PAGE_SCRIPT = [
  "var telemetry = document.getElementById('telemetry');",
  "var systemsBody = document.getElementById('systems-body');",
  "var logEl = document.getElementById('log');",
  "var statusEl = document.getElementById('status');",
  "var vmEl = document.getElementById('vm');",
  "var ownersBody = document.getElementById('owners-body');",
  "function cell(node, value, cls) {",
  "  var td = document.createElement('td');",
  "  td.textContent = value === null || value === undefined ? '-' : String(value);",
  "  if (cls) { td.className = cls; }",
  "  node.appendChild(td);",
  "}",
  "function row(label, value) { var tr = document.createElement('tr'); cell(tr, label); cell(tr, value); return tr; }",
  "function fixed(value, digits) { return typeof value === 'number' ? value.toFixed(digits) : '-'; }",
  "function renderTelemetry(o) {",
  "  telemetry.textContent = '';",
  "  if (!o.ok || !o.observation) {",
  "    telemetry.appendChild(row('observation', 'unavailable'));",
  "    telemetry.appendChild(row('code', o.code));",
  "    telemetry.appendChild(row('detail', o.detail));",
  "    telemetry.appendChild(row('seq', o.seq));",
  "    return;",
  "  }",
  "  var s = o.observation;",
  "  telemetry.appendChild(row('seq', o.seq));",
  "  telemetry.appendChild(row('callsign', s.callsign));",
  "  telemetry.appendChild(row('position', fixed(s.position.x, 1) + ', ' + fixed(s.position.y, 1)));",
  "  telemetry.appendChild(row('rotation', fixed(s.rotation, 1)));",
  "  telemetry.appendChild(row('heading', fixed(s.heading, 1)));",
  "  telemetry.appendChild(row('velocity', fixed(s.velocity.x, 2) + ', ' + fixed(s.velocity.y, 2)));",
  "  telemetry.appendChild(row('speed', fixed(s.speed, 2)));",
  "  telemetry.appendChild(row('impulse level', fixed(s.impulse_level, 2)));",
  "  telemetry.appendChild(row('energy', fixed(s.energy_level, 1) + ' / ' + fixed(s.energy_max, 1)));",
  "  systemsBody.textContent = '';",
  "  ['reactor', 'impulse', 'maneuver'].forEach(function (name) {",
  "    var sys = s.systems[name];",
  "    var tr = document.createElement('tr');",
  "    cell(tr, name);",
  "    cell(tr, fixed(sys.power, 2));",
  "    cell(tr, fixed(sys.coolant, 2));",
  "    cell(tr, fixed(sys.health, 2));",
  "    cell(tr, fixed(sys.heat, 2));",
  "    systemsBody.appendChild(tr);",
  "  });",
  "}",
  "function renderOwners(roles) {",
  "  ownersBody.textContent = '';",
  "  ['helms', 'engineering'].forEach(function (key) {",
  "    var role = roles[key];",
  "    var tr = document.createElement('tr');",
  "    cell(tr, key);",
  "    cell(tr, role.owner);",
  "    cell(tr, role.rule_controller_enabled ? 'yes' : 'no');",
  "    cell(tr, String(role.external.window_used) + '/' + String(role.external.rate_limit) + ' per minute');",
  "    cell(tr, String(role.decisions.length) + ' recent');",
  "    ownersBody.appendChild(tr);",
  "  });",
  "}",
  "function renderAgents(state) {",
  "  vmEl.textContent = 'vm api ' + state.vm.api_url + ' reachable=' + state.vm.reachable +",
  "    ' calls=' + state.vm.calls + ' vm_seq=' + state.vm.observation_seq +",
  "    ' RULE_CONTROLLERS=' + state.rule_controllers.raw;",
  "  renderOwners(state.roles);",
  "  statusEl.textContent = Object.keys(state.agents).map(function (key) {",
  "    var a = state.agents[key];",
  "    var i = a.last_intent ? a.last_intent.intent + ' ' + JSON.stringify(a.last_intent.args) : 'no intent';",
  "    var r = a.last_result ? a.last_result.outcome + (a.last_result.code ? ':' + a.last_result.code : '') : 'no result';",
  "    var state_ = a.enabled ? i + ' -> ' + r : 'disabled';",
  "    return key + ' [' + a.role + '] ' + state_ + ' (' + a.window_used + '/' + a.rate_limit + ' per minute)';",
  "  }).join('   |   ');",
  "}",
  "function renderLog(entries) {",
  "  logEl.textContent = '';",
  "  entries.slice().reverse().forEach(function (entry) {",
  "    var item = document.createElement('li');",
  "    var at = document.createElement('span');",
  "    at.className = 'at';",
  "    at.textContent = entry.at.slice(11, 19) + ' ';",
  "    item.appendChild(at);",
  "    var agent = document.createElement('span');",
  "    agent.className = entry.agent;",
  "    agent.textContent = entry.agent + ' ';",
  "    item.appendChild(agent);",
  "    var body = document.createElement('span');",
  "    body.className = entry.outcome;",
  "    body.textContent = entry.outcome + ' tick ' + entry.tick + ' ' + JSON.stringify(",
  "      entry.intents.map(function (i) { return { intent: i.intent, args: i.args, result: i.result }; })) +",
  "      ' ' + entry.note;",
  "    item.appendChild(body);",
  "    logEl.appendChild(item);",
  "  });",
  "}",
  "function render(state) {",
  "  renderTelemetry(state.observation);",
  "  renderAgents(state);",
  "  renderLog(state.log || []);",
  "}",
  "async function poll() {",
  "  try {",
  "    var response = await fetch('/state', { headers: { accept: 'application/json' } });",
  "    if (!response.ok) { return; }",
  "    render(await response.json());",
  "  } catch (error) {",
  "    document.getElementById('status').textContent = 'poll failed: ' + String(error);",
  "  }",
  "}",
  "poll();",
  "setInterval(poll, 1000);",
].join("\n");

export function renderSpectatorPage(controllerLabel: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>EmptyEpsilon agent demo</title>",
    "<style>",
    PAGE_STYLES,
    "</style>",
    "</head>",
    "<body>",
    "<h1>Agent-only EmptyEpsilon demo</h1>",
    `<p class="label">${controllerLabel}</p>`,
    `<p class="notice" role="status">${TAGLINE}</p>`,
    '<p class="sub" id="vm"></p>',
    '<p class="sub" id="status"></p>',
    "<main>",
    '<section aria-labelledby="owners-heading"><h2 id="owners-heading">Role ownership</h2>',
    "<table><thead><tr><th>role</th><th>owner</th><th>rule controller</th>",
    "<th>external rate</th><th>decisions</th></tr></thead>",
    '<tbody id="owners-body"></tbody></table>',
    "</section>",
    '<section aria-labelledby="telemetry-heading"><h2 id="telemetry-heading">Ship telemetry</h2>',
    '<table id="telemetry"><tbody></tbody></table>',
    "<table><thead><tr><th>system</th><th>power</th><th>coolant</th><th>health</th><th>heat</th></tr></thead>",
    '<tbody id="systems-body"></tbody></table>',
    "</section>",
    '<section aria-labelledby="log-heading"><h2 id="log-heading">Deterministic controller decision log</h2>',
    '<ol id="log"></ol>',
    "</section>",
    "</main>",
    "<script>",
    PAGE_SCRIPT,
    "</script>",
    "</body>",
    "</html>",
  ].join("\n");
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

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(html),
  });
  response.end(html);
}

type JsonBody =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; status: number; error: string; detail: string };

function readJsonBody(request: IncomingMessage): Promise<JsonBody> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (result: JsonBody): void => {
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
      if (!isRecord(parsed)) {
        finish({
          ok: false,
          status: 400,
          error: "BAD_BODY",
          detail: "body must be a JSON object",
        });
        return;
      }
      finish({ ok: true, value: parsed });
    });
  });
}

type ExternalIntent =
  | {
      ok: true;
      role: VmCommandRole;
      intent: string;
      args: Record<string, unknown>;
      request_id: string;
      agent_label: string | null;
    }
  | { ok: false; status: number; error: string; detail: string };

export function parseExternalIntent(body: Record<string, unknown>): ExternalIntent {
  if (Object.keys(body).some((key) => isLuaFieldKey(key.toLowerCase()))) {
    return {
      ok: false,
      status: 400,
      error: "RAW_LUA_REFUSED",
      detail: "this endpoint carries intent names and args only, never lua",
    };
  }
  const role = body["role"];
  if (!isVmCommandRole(role)) {
    return { ok: false, status: 400, error: "INVALID_ROLE", detail: "role must be helms or engineering" };
  }
  const intent = body["intent"];
  const args = body["args"];
  if (typeof intent !== "string" || !isRecord(args)) {
    return {
      ok: false,
      status: 400,
      error: "INVALID_INTENT",
      detail: "intent must be a string and args must be an object",
    };
  }
  const label = normalizeAgentLabel(body["agent_label"]);
  if (!label.ok) {
    return { ok: false, status: 400, error: "INVALID_AGENT_LABEL", detail: label.detail };
  }
  const classified = classifyIntent(intent, role);
  if (!classified.ok) {
    return {
      ok: false,
      status: 400,
      error: classified.code,
      detail: `intent ${intent} is not permitted for ${role}`,
    };
  }
  const validated = validateIntentArgs(classified.intent, args);
  if (!validated.ok) {
    return {
      ok: false,
      status: 400,
      error: validated.code,
      detail: `args rejected for ${intent}`,
    };
  }
  const requestId = body["request_id"];
  return {
    ok: true,
    role,
    intent,
    args,
    agent_label: label.label,
    request_id:
      typeof requestId === "string" && requestId.length > 0 && requestId.length <= 128
        ? requestId
        : `external-${role}-${String(Date.now())}`,
  };
}

export function createSpectatorServer(state: DriveState): Server {
  return createHttpServer((request: IncomingMessage, response: ServerResponse) => {
    const method = request.method ?? "GET";
    let pathname = "/";
    try {
      pathname = new URL(request.url ?? "/", "http://spectator.invalid").pathname;
    } catch {
      sendJson(response, 400, { ok: false, error: "BAD_REQUEST" });
      return;
    }
    if (method === "GET" && pathname === "/") {
      sendHtml(response, renderSpectatorPage(CONTROLLER_LABEL));
      return;
    }
    if (method === "GET" && pathname === "/state") {
      sendJson(response, 200, statePayload(state));
      return;
    }
    if (pathname === "/api/intent") {
      if (method !== "POST") {
        sendJson(response, 405, { ok: false, error: "METHOD_NOT_ALLOWED", detail: "use POST" });
        return;
      }
      void readJsonBody(request).then((body) => {
        if (!body.ok) {
          sendJson(response, body.status, { ok: false, error: body.error, detail: body.detail });
          return;
        }
        const parsed = parseExternalIntent(body.value);
        if (!parsed.ok) {
          sendJson(response, parsed.status, { ok: false, error: parsed.error, detail: parsed.detail });
          return;
        }
        const seat = seatLookup(state, parsed.role);
        const external = state.external[parsed.role];
        const limiter = state.externalLimiters[parsed.role];
        external.requests += 1;
        external.last_request_id = parsed.request_id;
        external.last_at = new Date().toISOString();
        external.last_agent_label = parsed.agent_label;
        const now = Date.now();
        if (!limiter.tryTake(now)) {
          external.rate_limited += 1;
          const record: RoleDecisionRecord = {
            at: new Date(now).toISOString(),
            kind: "external_role_agent",
            role: parsed.role,
            agent: FIXED_ACTOR_IDS[parsed.role],
            agent_label: parsed.agent_label,
            request_id: parsed.request_id,
            intent: parsed.intent,
            args: parsed.args,
            outcome: "rate_limited",
            result: null,
            note: `external role agents are capped at ${String(limiter.limit)} intents per ${String(
              limiter.windowMs,
            )}ms for ${parsed.role}`,
          };
          state.externalLogs[parsed.role].push(record);
          logLine({ ...record, kind: "external_role_agent" });
          sendJson(response, 429, {
            ok: false,
            error: "RATE_LIMITED",
            detail: record.note,
            result: null,
          });
          return;
        }
        void state.client
          .command({
            role: parsed.role,
            actor_id: FIXED_ACTOR_IDS[parsed.role],
            request_id: parsed.request_id,
            intent: parsed.intent,
            args: parsed.args,
            generation: seat && seat.generation >= 0 ? seat.generation : undefined,
          })
          .then((outcome) => {
            if (outcome.summary.outcome === "accepted") {
              external.accepted += 1;
            } else if (outcome.summary.outcome === "refused") {
              external.refused += 1;
            } else {
              external.failed += 1;
            }
            const record: RoleDecisionRecord = {
              at: new Date(outcome.at).toISOString(),
              kind: "external_role_agent",
              role: parsed.role,
              agent: FIXED_ACTOR_IDS[parsed.role],
              agent_label: parsed.agent_label,
              request_id: parsed.request_id,
              intent: parsed.intent,
              args: parsed.args,
              outcome: outcome.summary.outcome,
              result: outcome.summary,
              note: outcome.detail,
            };
            state.externalLogs[parsed.role].push(record);
            logLine({
              at: record.at,
              kind: "external_role_agent",
              role: record.role,
              actor_id: record.agent,
              agent_label: record.agent_label,
              request_id: record.request_id,
              intent: record.intent,
              args: record.args,
              outcome: record.outcome,
              code: outcome.summary.code,
              reason: outcome.summary.reason,
              note: record.note,
            });
            const status = outcome.summary.outcome === "accepted"
              ? 200
              : outcome.summary.outcome === "refused"
                ? 409
                : outcome.summary.outcome === "timeout"
                  ? 504
                  : 502;
            sendJson(response, status, { ok: outcome.ok, result: outcome.summary });
          })
          .catch((error: unknown) => {
            external.failed += 1;
            const record: RoleDecisionRecord = {
              at: new Date().toISOString(),
              kind: "external_role_agent",
              role: parsed.role,
              agent: FIXED_ACTOR_IDS[parsed.role],
              agent_label: parsed.agent_label,
              request_id: parsed.request_id,
              intent: parsed.intent,
              args: parsed.args,
              outcome: "vm_api_unreachable",
              result: null,
              note: error instanceof Error ? error.message : String(error),
            };
            state.externalLogs[parsed.role].push(record);
            logLine({ ...record, kind: "external_role_agent" });
            sendJson(response, 502, {
              ok: false,
              error: "VM_API_UNREACHABLE",
              detail: record.note,
            });
          });
      });
      return;
    }
    sendJson(response, 404, { ok: false, error: "NOT_FOUND", detail: `no route for ${pathname}` });
  });
}

function observationSnapshot(
  seq: number,
  at: number,
  result: ObservationResult,
): ObservationSnapshot {
  return {
    seq,
    at: new Date(at).toISOString(),
    age_ms: 0,
    ok: result.ok,
    code: result.ok ? null : result.code,
    detail: result.ok ? "" : result.detail,
    observation: result.ok ? result.observation : null,
  };
}

export async function runDrive(options: DriveOptions): Promise<Server> {
  const client = new VmApiPort({
    url: options.apiUrl,
    token: options.apiToken,
    timeout_ms: options.apiTimeoutMs,
  });
  const health = await client.health();
  if (!health.ok || health.ship === null) {
    throw new Error(
      `vm api health check failed at ${client.baseUrl}: ${health.detail || "no ship reported"}`,
    );
  }
  if (options.expectedShip !== null && options.expectedShip !== health.ship) {
    throw new Error(
      `vm api is bound to ${health.ship} but SHIP_CALLSIGN on the drive says ${options.expectedShip}`,
    );
  }
  const log: DecisionLogEntry[] = [];
  const recordDecision = (line: string): void => {
    process.stdout.write(`${line}\n`);
    try {
      const parsed = JSON.parse(line) as AgentDecision;
      log.push({ ...parsed, kind: "deterministic_controller" });
      while (log.length > options.logLimit) {
        log.shift();
      }
    } catch {
      logLine({ kind: "log_parse_failed", line });
    }
  };
  const emptyExternal = (): ExternalRoleState => ({
    requests: 0,
    accepted: 0,
    refused: 0,
    failed: 0,
    rate_limited: 0,
    last_request_id: null,
    last_at: null,
    last_agent_label: null,
  });
  const state: DriveState = {
    options,
    client,
    ship: health.ship,
    epoch: health.epoch ?? 1,
    vmSeats: health.seats,
    vmHealth: health,
    startedAt: Date.now(),
    observationSeq: 0,
    observation: observationSnapshot(
      0,
      Date.now(),
      observationFailure("PORT_ERROR", "no observation yet", ""),
    ),
    agents: {
      helm: createHelmAgent({
        client,
        seat: (role) => seatLookup(state, role),
        enabled: ruleControllerEnabled(options, "helms"),
        rateLimit: options.rateLimit,
        log: recordDecision,
        waypoint: options.waypoint,
        defaultHeading: options.defaultHeading,
      }),
      engineering: createEngineeringAgent({
        client,
        seat: (role) => seatLookup(state, role),
        enabled: ruleControllerEnabled(options, "engineering"),
        rateLimit: options.rateLimit,
        log: recordDecision,
      }),
    },
    log,
    tick: {
      index: 0,
      last_started_at: null,
      last_finished_at: null,
      last_duration_ms: null,
      failures: 0,
    },
    external: { helms: emptyExternal(), engineering: emptyExternal() },
    externalLogs: { helms: new RoleDecisionLog(), engineering: new RoleDecisionLog() },
    externalLimiters: {
      helms: new RateLimiter(EXTERNAL_INTENTS_PER_MINUTE),
      engineering: new RateLimiter(EXTERNAL_INTENTS_PER_MINUTE),
    },
  };
  logLine({
    at: new Date().toISOString(),
    kind: "rule_controllers",
    raw: process.env["RULE_CONTROLLERS"] ?? "helms,engineering",
    helms: ownerLabel(ruleControllerEnabled(options, "helms")),
    engineering: ownerLabel(ruleControllerEnabled(options, "engineering")),
    external_intents_per_minute: EXTERNAL_INTENTS_PER_MINUTE,
    max_agent_label_length: MAX_AGENT_LABEL_LENGTH,
  });

  const server = createSpectatorServer(state);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.spectatorPort, options.spectatorHost, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const boundPort =
    typeof address === "object" && address !== null ? address.port : options.spectatorPort;
  logLine({
    at: new Date().toISOString(),
    kind: "listening",
    url: `http://${options.spectatorHost}:${String(boundPort)}/`,
    vm_api: client.baseUrl,
    vm_token_source: options.apiTokenSource,
    ship: state.ship,
    epoch: state.epoch,
    controller_label: CONTROLLER_LABEL,
  });

  let running = false;
  const runTick = async (): Promise<void> => {
    if (running) {
      return;
    }
    running = true;
    const startedAt = Date.now();
    state.tick.index += 1;
    state.tick.last_started_at = new Date(startedAt).toISOString();
    const index = state.tick.index;
    const healthNow = await client.health();
    state.vmHealth = healthNow;
    state.vmSeats = healthNow.seats;
    const observation = await client.observe();
    if (!observation.result.ok) {
      state.tick.failures += 1;
      state.observation = observationSnapshot(
        state.observationSeq,
        observation.at,
        observation.result,
      );
      logLine({
        at: new Date(observation.at).toISOString(),
        kind: "observation",
        tick: index,
        ok: false,
        code: observation.result.code,
        detail: observation.result.detail,
      });
    } else {
      state.observationSeq += 1;
      const current = observation.result.observation;
      if (current.callsign !== state.ship) {
        logLine({
          at: new Date(observation.at).toISOString(),
          kind: "callsign_drift",
          tick: index,
          bound: state.ship,
          observed: current.callsign,
          note: "the vm api keeps its fixed binding; intents still target the bound ship",
        });
      }
      state.observation = observationSnapshot(state.observationSeq, observation.at, observation.result);
      await state.agents.helm.tick(current, state.observationSeq, index);
      await state.agents.engineering.tick(current, state.observationSeq, index);
    }
    const finishedAt = Date.now();
    state.tick.last_finished_at = new Date(finishedAt).toISOString();
    state.tick.last_duration_ms = finishedAt - startedAt;
    running = false;
    schedule();
  };
  const schedule = (): void => {
    const timer = setTimeout(() => {
      void runTick();
    }, Math.max(50, options.tickMs));
    if (typeof timer.unref === "function") timer.unref();
  };
  void runTick();
  return server;
}

async function main(): Promise<void> {
  const options = loadDriveOptions();
  const server = await runDrive(options);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      server.close(() => {
        process.exit(0);
      });
    });
  }
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("real/main.ts") || entry.endsWith("real/main.js")) {
  main().catch((error: unknown) => {
    logLine({
      at: new Date().toISOString(),
      kind: "fatal",
      detail: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
}