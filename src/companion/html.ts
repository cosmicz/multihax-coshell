import { ORDER_TEXT_MAX, ROLES, STALE_AFTER_MS } from "./types.ts";
import type { Role, SeatSnapshot, StateSnapshot } from "./types.ts";

export interface PageOptions {
  pollMs?: number;
  staleAfterMs?: number;
}

export function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatAge(ageMs: number): string {
  if (typeof ageMs !== "number" || !Number.isFinite(ageMs) || ageMs < 0) {
    return "unknown";
  }
  return (ageMs / 1000).toFixed(1) + "s";
}

function seatRow(seat: SeatSnapshot): string {
  const classes = seat.stale ? "seat seat--stale" : "seat";
  const age = formatAge(seat.age_ms) + (seat.stale ? " stale" : " fresh");
  return [
    '<tr class="' + classes + '">',
    '<td class="role">' + escapeHtml(seat.role) + "</td>",
    '<td class="kind">' + escapeHtml(seat.kind) + "</td>",
    '<td class="occ occ--' + escapeHtml(seat.native_occupancy) + '">' + escapeHtml(seat.native_occupancy) + "</td>",
    '<td class="mode mode--' + escapeHtml(seat.mode) + '">' + escapeHtml(seat.mode) + "</td>",
    '<td class="gen">' + escapeHtml(String(seat.generation)) + "</td>",
    '<td class="age ' + (seat.stale ? "stale" : "fresh") + '">' + escapeHtml(age) + "</td>",
    '<td class="actions">',
    '<button type="button" class="btn" data-role="' + escapeHtml(seat.role) + '" data-action="resume">Resume</button>',
    '<button type="button" class="btn" data-role="' + escapeHtml(seat.role) + '" data-action="pause">Pause</button>',
    "</td>",
    "</tr>",
  ].join("");
}

function timelineItems(snapshot: StateSnapshot): string {
  const entries = snapshot.timeline;
  if (entries.length === 0) {
    return '<li class="entry entry--empty">no orders yet</li>';
  }
  const items: string[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }
    const when = new Date(entry.at).toISOString().slice(11, 19);
    const label = entry.kind + (entry.role === null ? "" : " to " + entry.role);
    items.push(
      '<li class="entry entry--' +
        escapeHtml(entry.kind) +
        '"><span class="time">' +
        escapeHtml(when) +
        '</span><span class="kind">' +
        escapeHtml(label) +
        '</span><span class="body">' +
        escapeHtml(entry.text) +
        "</span></li>",
    );
  }
  return items.join("\n");
}

function missionLine(snapshot: StateSnapshot): string {
  const status = snapshot.mission.status;
  const source = snapshot.mission.source;
  if (status === "won") {
    return (
      '<p class="mission mission--won" id="mission"><strong>mission: won</strong>' +
      '<span class="mission-source"> source: ' +
      escapeHtml(source) +
      "</span></p>"
    );
  }
  return (
    '<p class="mission mission--' +
    escapeHtml(status) +
    '" id="mission"><strong>mission: ' +
    escapeHtml(status) +
    '</strong><span class="mission-source"> source: ' +
    escapeHtml(source) +
    '</span><span class="mission-hint"> reported by the scenario only, never inferred</span></p>'
  );
}

function roleOptions(): string {
  const options: string[] = [];
  for (const role of ROLES as readonly Role[]) {
    options.push('<option value="' + escapeHtml(role) + '">' + escapeHtml(role) + "</option>");
  }
  return options.join("");
}

const STYLES = [
  ":root { color-scheme: dark; }",
  "* { box-sizing: border-box; }",
  "body { margin: 0; padding: 1.5rem; background: #0d1117; color: #d7e0ea;",
  "  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 14px; line-height: 1.5; }",
  "h1 { font-size: 1.25rem; margin: 0 0 0.25rem; }",
  "h2 { font-size: 1rem; margin: 0 0 0.5rem; color: #9fb3c8; text-transform: uppercase; letter-spacing: 0.08em; }",
  ".notice { border: 1px solid #7a5c00; background: #2a2200; color: #ffd479; padding: 0.6rem 0.8rem;",
  "  border-radius: 6px; margin: 0 0 1rem; max-width: 70ch; }",
  ".sub { color: #8b9bb0; margin: 0 0 1rem; }",
  "main { display: grid; gap: 1.25rem; max-width: 78ch; }",
  "section { border: 1px solid #22303f; border-radius: 6px; padding: 0.8rem; background: #111823; }",
  "table { width: 100%; border-collapse: collapse; }",
  "th, td { text-align: left; padding: 0.3rem 0.5rem; border-bottom: 1px solid #1c2735; }",
  "th { color: #7f93a8; font-weight: 600; }",
  "tr.seat--stale td { color: #ff9d9d; }",
  ".occ--occupied { color: #7ee787; }",
  ".occ--vacant { color: #8b9bb0; }",
  ".mode--HUMAN { color: #79c0ff; }",
  ".mode--AGENT { color: #d2a8ff; }",
  ".mode--PAUSED { color: #ffa657; }",
  ".stale { color: #ff9d9d; }",
  ".fresh { color: #6b7d90; }",
  ".btn { background: #1f6feb; border: 1px solid #2b7bf0; color: #fff; border-radius: 4px;",
  "  padding: 0.15rem 0.5rem; margin-right: 0.3rem; cursor: pointer; font: inherit; }",
  ".btn:hover { background: #2b7bf0; }",
  "form { display: grid; gap: 0.5rem; max-width: 60ch; }",
  "select, textarea { background: #0d1117; color: #d7e0ea; border: 1px solid #2b3a4d;",
  "  border-radius: 4px; padding: 0.35rem; font: inherit; }",
  "textarea { min-height: 4rem; resize: vertical; }",
  "#timeline { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.3rem; }",
  ".entry { display: grid; grid-template-columns: 8ch 16ch 1fr; gap: 0.5rem; padding: 0.25rem 0;",
  "  border-bottom: 1px solid #1c2735; }",
  ".entry .time { color: #6b7d90; }",
  ".entry .kind { color: #9fb3c8; }",
  ".entry--order .kind { color: #d2a8ff; }",
  ".entry--pause .kind { color: #ffa657; }",
  ".entry--resume .kind { color: #7ee787; }",
  ".mission--won { color: #7ee787; }",
  ".mission--lost { color: #ff9d9d; }",
  ".mission-source, .mission-hint { color: #6b7d90; margin-left: 0.5rem; }",
  "#ship { color: #8b9bb0; }",
  "#order-status { color: #9fb3c8; min-height: 1.2rem; }",
].join("\n");

const CLIENT_SCRIPT = [
  "(function () {",
  "  var POLL_MS = __POLL_MS__;",
  '  var seatsBody = document.getElementById("seats-body");',
  '  var timelineEl = document.getElementById("timeline");',
  '  var missionEl = document.getElementById("mission");',
  '  var shipEl = document.getElementById("ship");',
  '  var orderStatusEl = document.getElementById("order-status");',
  '  var form = document.getElementById("order-form");',
  '  var roleSelect = document.getElementById("to-role");',
  '  var textInput = document.getElementById("order-text");',
  '  function el(tag, value, className) {',
  "    var node = document.createElement(tag);",
  '    node.textContent = value === null || value === undefined ? "" : String(value);',
  "    if (className) { node.className = className; }",
  "    return node;",
  "  }",
  "  function formatAge(ms) {",
  "    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) { return 'unknown'; }",
  "    return (ms / 1000).toFixed(1) + 's';",
  "  }",
  "  function cell(value, className) { return el('td', value, className); }",
  "  function seatRow(seat) {",
  "    var row = el('tr', null, seat.stale ? 'seat seat--stale' : 'seat');",
  "    row.appendChild(cell(seat.role, 'role'));",
  "    row.appendChild(cell(seat.kind, 'kind'));",
  "    row.appendChild(cell(seat.native_occupancy, 'occ occ--' + seat.native_occupancy));",
  "    row.appendChild(cell(seat.mode, 'mode mode--' + seat.mode));",
  "    row.appendChild(cell(String(seat.generation), 'gen'));",
  "    row.appendChild(cell(formatAge(seat.age_ms) + (seat.stale ? ' stale' : ' fresh'),",
  "      seat.stale ? 'stale' : 'fresh'));",
  "    var actions = el('td', null, 'actions');",
  "    ['resume', 'pause'].forEach(function (action) {",
  "      var button = el('button', action === 'resume' ? 'Resume' : 'Pause', 'btn');",
  "      button.type = 'button';",
  "      button.setAttribute('data-role', seat.role);",
  "      button.setAttribute('data-action', action);",
  "      actions.appendChild(button);",
  "    });",
  "    row.appendChild(actions);",
  "    return row;",
  "  }",
  "  function renderSeats(snapshot) {",
  "    seatsBody.textContent = '';",
  "    (snapshot.seats || []).forEach(function (seat) { seatsBody.appendChild(seatRow(seat)); });",
  "  }",
  "  function renderTimeline(snapshot) {",
  "    timelineEl.textContent = '';",
  "    var entries = (snapshot.timeline || []).slice().reverse();",
  "    if (entries.length === 0) {",
  "      timelineEl.appendChild(el('li', 'no orders yet', 'entry entry--empty'));",
  "      return;",
  "    }",
  "    entries.forEach(function (entry) {",
  "      var item = el('li', null, 'entry entry--' + entry.kind);",
  "      item.appendChild(el('span', new Date(entry.at).toISOString().slice(11, 19), 'time'));",
  "      item.appendChild(el('span', entry.kind + (entry.role ? ' to ' + entry.role : ''), 'kind'));",
  "      item.appendChild(el('span', entry.text, 'body'));",
  "      timelineEl.appendChild(item);",
  "    });",
  "  }",
  "  function renderMission(snapshot) {",
  "    var mission = snapshot.mission || { status: 'unknown', source: 'unknown' };",
  "    missionEl.className = 'mission mission--' + mission.status;",
  "    missionEl.textContent = '';",
  "    missionEl.appendChild(el('strong', 'mission: ' + mission.status));",
  "    missionEl.appendChild(el('span', ' source: ' + mission.source, 'mission-source'));",
  "    if (mission.status !== 'won') {",
  "      missionEl.appendChild(el('span', ' reported by the scenario only, never inferred', 'mission-hint'));",
  "    }",
  "  }",
  "  function render(snapshot) {",
  "    shipEl.textContent = 'ship: ' + snapshot.ship.name + ' \\u00b7 epoch ' + snapshot.epoch;",
  "    renderMission(snapshot);",
  "    renderSeats(snapshot);",
  "    renderTimeline(snapshot);",
  "  }",
  "  async function poll() {",
  "    try {",
  "      var response = await fetch('/api/state', { headers: { accept: 'application/json' } });",
  "      if (response.ok) { render(await response.json()); }",
  "    } catch (error) {",
  "      orderStatusEl.textContent = 'poll failed: ' + String(error);",
  "    }",
  "  }",
  "  async function postOrder(event) {",
  "    event.preventDefault();",
  "    var payload = { to_role: roleSelect.value, text: textInput.value };",
  "    try {",
  "      var response = await fetch('/api/orders', {",
  "        method: 'POST',",
  "        headers: { 'content-type': 'application/json' },",
  "        body: JSON.stringify(payload)",
  "      });",
  "      var body = await response.json();",
  "      if (response.ok) {",
  "        orderStatusEl.textContent = 'order delivered to ' + payload.to_role + ' (no ship systems actuated)';",
  "        textInput.value = '';",
  "      } else {",
  "        orderStatusEl.textContent = 'rejected: ' + (body.detail || body.error || 'unknown');",
  "      }",
  "      await poll();",
  "    } catch (error) {",
  "      orderStatusEl.textContent = 'request failed: ' + String(error);",
  "    }",
  "  }",
  "  async function seatAction(event) {",
  "    var target = event.target;",
  "    if (!target || !target.getAttribute) { return; }",
  "    var role = target.getAttribute('data-role');",
  "    var action = target.getAttribute('data-action');",
  "    if (!role || !action) { return; }",
  "    try {",
  "      var response = await fetch('/api/seats/' + encodeURIComponent(role) + '/' + action, { method: 'POST' });",
  "      var body = await response.json();",
  "      if (response.ok) {",
  "        orderStatusEl.textContent = action + ' ' + role + ': ok';",
  "      } else if (response.status === 409) {",
  "        orderStatusEl.textContent = action + ' ' + role + ' refused: ' + body.reason + ' (' + body.detail + ')';",
  "      } else {",
  "        orderStatusEl.textContent = action + ' ' + role + ' failed: ' + (body.detail || body.error || 'unknown');",
  "      }",
  "      await poll();",
  "    } catch (error) {",
  "      orderStatusEl.textContent = 'request failed: ' + String(error);",
  "    }",
  "  }",
  '  seatsBody.addEventListener("click", seatAction);',
  '  form.addEventListener("submit", postOrder);',
  "  poll();",
  "  setInterval(poll, POLL_MS);",
  "})();",
].join("\n");

export function renderCompanionPage(snapshot: StateSnapshot, options: PageOptions = {}): string {
  const pollMs = options.pollMs ?? 1000;
  const staleAfterMs = options.staleAfterMs ?? STALE_AFTER_MS;
  const script = CLIENT_SCRIPT.replace("__POLL_MS__", String(pollMs));
  const rows = snapshot.seats.map(seatRow).join("\n");
  const title = "Crew status and orders — " + escapeHtml(snapshot.ship.name);

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>" + title + "</title>",
    "<style>",
    STYLES,
    "</style>",
    "</head>",
    "<body>",
    '<p id="ship" class="sub"></p>',
    '<h1>Crew status and orders companion</h1>',
    '<p class="notice" role="status">Native client required: this companion only shows crew status and records',
    "captain orders. It cannot fly the ship. To play, connect with the native EmptyEpsilon client — helm,",
    "engineering and every other ship control lives there, and this page has no station controls.</p>",
    "<main>",
    '<section aria-labelledby="mission-heading"><h2 id="mission-heading">Mission</h2>',
    missionLine(snapshot),
    "</section>",
    '<section aria-labelledby="seats-heading"><h2 id="seats-heading">Seats</h2>',
    "<table>",
    "<thead><tr><th>role</th><th>kind</th><th>native</th><th>mode</th><th>gen</th>",
    "<th>age</th><th>seat control</th></tr></thead>",
    '<tbody id="seats-body">',
    rows,
    "</tbody>",
    "</table>",
    '<p class="sub">Seats older than ' + String(staleAfterMs / 1000) + "s are marked stale. Refresh every " +
      String(pollMs / 1000) + "s.</p>",
    "</section>",
    '<section aria-labelledby="timeline-heading"><h2 id="timeline-heading">Orders timeline</h2>',
    '<ol id="timeline">',
    timelineItems(snapshot),
    "</ol>",
    "</section>",
    '<section aria-labelledby="order-heading"><h2 id="order-heading">Captain order</h2>',
    '<form id="order-form">',
    '<label for="to-role">to role</label>',
    '<select id="to-role" name="to_role">',
    roleOptions(),
    "</select>",
    '<label for="order-text">order</label>',
    '<textarea id="order-text" name="text" maxlength="' + String(ORDER_TEXT_MAX) + '" rows="3"',
    ' placeholder="1-' + String(ORDER_TEXT_MAX) + ' characters"></textarea>',
    '<div><button type="submit" class="btn">Send order</button></div>',
    "</form>",
    '<p id="order-status" role="status"></p>',
    '<p class="sub">Orders are delivered to the addressed agent inbox and the timeline only; they never',
    "actuate ship systems.</p>",
    "</section>",
    "</main>",
    "<script>",
    script,
    "</script>",
    "</body>",
    "</html>",
  ].join("\n");
}