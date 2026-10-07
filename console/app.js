import { applyLocale, getLanguage, setLanguage, t } from "./shared/i18n.js";
import { DEFAULT_ACCEPTANCE_EVIDENCE as requiredEvidence } from "./model.js";
import { enrollmentDisplayName, selectRows } from "./shared/table-model.js";
import { icon } from "./shared/icons.js";
import { templateDisplay, templatePostureSummary, templateSelectionPayload } from "./enrollment/templates/model.js";
import { renderProviders } from "./providers/view.js";

// The UI owns presentation only. Authority, transitions and admission stay on the server.
const routes = ["overview", "devices", "enrollment", "approvals", "capabilities", "activity", "settings"];
const finalStates = new Set(["ACCEPTED", "CANCELLED", "FAILED"]);
const $ = (selector) => document.querySelector(selector);
const h = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const text = (key, values) => h(t(key, values));
const expired = (record) => Date.parse(record?.expires_at) <= Date.now();
const writable = () => access === "operator" && !!snapshot && !busy && !uncertain;
const disabled = () => writable() ? "" : " disabled";
let accessToken = "", access = null, snapshot = null, lastRead = null;
let busy = false, uncertain = false, epoch = 0, feedback = null;
let session = new AbortController();
let view = routes.includes(location.hash.slice(1)) ? location.hash.slice(1) : "overview";
let detailStack = [], detailOrigin = null;
let tableStates = createTableStates();
let createTemplateId = "", createTemplateOverrides = {};
const appearance = window.GhostFleetAppearance;
try { document.documentElement.dataset.navigation = localStorage.getItem("ghostfleet-nav-collapsed") === "true" ? "compact" : "full"; } catch {}

function createTableStates() {
  return Object.fromEntries(["devices", "enrollment", "approvals", "capabilities", "activity"].map((name) =>
    [name, { query: "", status: "", page: 1, pageSize: 10, sortKey: name === "capabilities" ? "name" : "date", direction: name === "capabilities" ? "asc" : "desc", tab: name === "enrollment" ? "current" : name === "approvals" ? "pending" : "all", hidden: new Set() }]));
}
function date(value, full = false) {
  if (!value || !Number.isFinite(Date.parse(value))) return t("unknown");
  return new Intl.DateTimeFormat(getLanguage(), { ...(full ? { year: "numeric" } : {}), month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}
function badge(state) {
  const tone = ["ACCEPTED", "ACTIVE", "APPROVED"].includes(state) ? "success"
    : ["WAITING_HUMAN", "WAITING", "RECONCILE_REQUIRED", "EXPIRED"].includes(state) ? "warning"
    : ["FAILED", "REJECTED"].includes(state) ? "danger"
    : ["PREPARING", "CLAIMED", "MATERIALIZING"].includes(state) ? "info" : "";
  return '<span class="state ' + tone + '" title="' + h(state) + '">' + text("state." + state) + "</span>";
}
function attemptState(attempt) { return !finalStates.has(attempt.state) && expired(attempt) ? "EXPIRED" : attempt.state; }
function attemptFor(gate) { return snapshot?.attempts.find((attempt) => attempt.attempt_id === gate.subject_id); }
function gateState(gate) { return gate.state === "WAITING" && (expired(gate) || expired(attemptFor(gate))) ? "EXPIRED" : gate.state; }
function gateActionable(gate) { const attempt = attemptFor(gate); return gate.state === "WAITING" && !expired(gate) && attempt?.state === "WAITING_HUMAN" && !expired(attempt); }
function activeAttempts() { return snapshot?.attempts.filter((attempt) => !finalStates.has(attempt.state) && !expired(attempt)) || []; }
function synthetic(node) {
  return syntheticEvidence(snapshot?.attempts.find((attempt) => attempt.attempt_id === node.enrollment_attempt_id));
}
function syntheticEvidence(attempt) { return attempt?.evidence?.some((item) => typeof item.source === "string" && item.source.startsWith("synthetic")); }
function permissionKey() { return uncertain ? "permissionUncertain" : busy && access === "operator" ? "operationPending" : "operatorNeeded"; }
function evidenceResults(attempt) {
  const latest = new Map((attempt.evidence || []).map((item) => [item.type, item]));
  return { latest, passed: requiredEvidence.filter((type) => latest.get(type)?.data?.status === "PASS").length };
}
function attemptName(attempt, fallback = attempt?.attempt_id) {
  return enrollmentDisplayName(attempt, snapshot?.nodes || [], fallback);
}
function subjectName(id) {
  const attempt = snapshot?.attempts.find((item) => item.attempt_id === id);
  if (attempt) return attemptName(attempt, id);
  const node = snapshot?.nodes.find((item) => item.node_uid === id);
  if (node) return node.node_id;
  return attemptName(attemptFor(snapshot?.gates.find((gate) => gate.gate_id === id) || {}), id);
}
function empty(title, description, symbol = "devices", reset = false) {
  return '<div class="empty-state">' + icon(symbol) + "<strong>" + text(title) + "</strong><p>" + text(description) + "</p>" +
    (reset ? '<button type="button" class="btn btn-outline-secondary" data-reset-filters>' + text("clearFilters") + "</button>" : "") + "</div>";
}
function showFeedback(key, tone = "", values = {}) { feedback = { key, tone, values }; renderFeedback(); }
function renderFeedback() {
  for (const selector of ["#feedback", "#create-feedback", "#detail-feedback"]) {
    const node = $(selector);
    node.hidden = !feedback;
    node.className = "feedback " + (feedback?.tone || "");
    node.textContent = feedback ? t(feedback.key, feedback.values) : "";
  }
  for (const selector of ["#create-recovery", "#detail-recovery"]) {
    $(selector).hidden = !uncertain && feedback?.tone !== "error";
    $(selector + " button").disabled = !snapshot || busy;
  }
}

async function api(path, options = {}) {
  const mutation = options.method === "POST";
  let response, data;
  try {
    response = await fetch(path, { ...options, cache: "no-store", signal: AbortSignal.any([session.signal, AbortSignal.timeout(15000)]),
      headers: { "content-type": "application/json", authorization: "Bearer " + accessToken } });
    data = await response.json();
  } catch {
    const error = new Error("NETWORK_ERROR");
    error.ambiguous = mutation;
    throw error;
  }
  if (!response.ok || data.ok === false) {
    const error = new Error(data.error || "REQUEST_FAILED");
    error.ambiguous = mutation && response.status >= 500;
    throw error;
  }
  return data;
}
const post = (path, payload = {}) => api(path, { method: "POST", body: JSON.stringify(payload) });
async function readSnapshot() {
  const [permissions, attempts, gates, nodes, events, capabilities, templates, providers] = await Promise.all([
    api("/v0/access"), api("/v0/enrollment-attempts"), api("/v0/human-gates"), api("/v0/nodes"), api("/v0/events"), api("/v0/capabilities"), api("/v0/enrollment-templates"), api("/v0/providers/setup"),
  ]);
  if (!["operator", "read_only"].includes(permissions.access)) throw new Error("UNAUTHORIZED");
  return { access: permissions.access, attempts: attempts.attempts, gates: gates.gates, nodes: nodes.nodes, events: events.events, capabilities: capabilities.capabilities, templates: templates.templates, providers };
}

function navigation() {
  const pending = snapshot?.gates.filter(gateActionable).length || 0;
  const items = routes.filter((route) => route !== "settings").map((route) =>
    '<a class="nav-link" href="#' + route + '" title="' + text(route) + '"' + (view === route ? ' aria-current="page"' : "") + ">" +
    icon(route) + '<span class="nav-label">' + text(route) + "</span>" +
    (route === "approvals" && pending ? '<span class="nav-count">' + h(pending) + "</span>" : "") + "</a>").join("");
  return '<span class="navigation-label">' + text("workspace") + "</span>" + items +
    '<div class="nav-divider"></div><a class="nav-link" href="#settings" title="' + text("settings") + '"' + (view === "settings" ? ' aria-current="page"' : "") + ">" + icon("settings") + '<span class="nav-label">' + text("settings") + "</span></a>";
}
function renderShell() {
  for (const node of document.querySelectorAll(".module-navigation")) node.innerHTML = navigation();
  for (const node of document.querySelectorAll(".sidebar-session")) node.innerHTML =
    "<strong>" + text(snapshot ? access === "operator" ? "shortOperator" : "shortReadOnly" : "disconnected") + '</strong><span class="secondary">' + text(snapshot ? "memorySession" : "summaryDisconnected") + "</span>";
  $("#breadcrumb-current").textContent = t(view);
  $("#page-title").textContent = t(view);
  $("#page-description").textContent = t("description." + view);
  $("#connection-status").textContent = t(snapshot ? access === "operator" ? "shortOperator" : "shortReadOnly" : "disconnected");
  $("#session-link").className = "session-button" + (snapshot ? " connected" : "");
  $("#session-link").setAttribute("aria-label", t("connection") + " · " + $("#connection-status").textContent);
  $("#refresh").disabled = !snapshot || busy;
  $("#refresh-label").textContent = t(busy ? "refreshing" : "refresh");
  $("#open-create").disabled = !writable();
  $("#open-create").hidden = !["overview", "devices", "enrollment"].includes(view);
  $("#api-token").disabled = busy;
  $("#connect-button").disabled = busy;
  $("#connect-button").textContent = t(busy && !snapshot ? "connecting" : "connect");
  $("#disconnect").disabled = !accessToken;
  $("#asset-hint").disabled = !writable();
  $("#template-select").disabled = !writable();
  $("#template-tailscale-ssh")?.toggleAttribute("disabled", !writable());
  $("#new-attempt button[type=submit]").disabled = !writable();
  $("#create-permission").textContent = writable() ? "" : t(permissionKey());
  $("#connection-access").textContent = snapshot ? t(access === "operator" ? "permissionOperator" : "permissionReadOnly") : "";
  $("#permission-banner").hidden = !uncertain && !(snapshot && access === "read_only" && ["enrollment", "approvals"].includes(view));
  $("#permission-banner").textContent = t(uncertain ? "permissionUncertain" : "permissionReadOnly");
  $("#last-read").textContent = lastRead ? t("lastRead", { time: date(lastRead) }) : "";
  $("#navigation-toggle").setAttribute("aria-expanded", String(innerWidth <= 900 ? $("#navigation-dialog").open : document.documentElement.dataset.navigation !== "compact"));
  $("#theme-toggle").innerHTML = icon(appearance.isDark() ? "sun" : "moon");
  $("#theme-preference").value = appearance.getPreference();
}

function selectedCreateTemplate() {
  const templates = snapshot?.templates ?? [];
  return templates.find((item) => item.template_id === createTemplateId) ?? templates[0] ?? null;
}
function renderCreateTemplateControls() {
  const select = $("#template-select");
  const preview = $("#template-preview");
  const options = $("#template-options");
  const description = $("#template-description");
  if (!select || !preview || !options || !description) return;
  const templates = snapshot?.templates ?? [];
  if (!templates.length) {
    select.replaceChildren();
    select.disabled = true;
    description.textContent = t("noEnrollmentTemplates");
    preview.replaceChildren();
    options.replaceChildren();
    return;
  }
  if (!templates.some((item) => item.template_id === createTemplateId)) {
    createTemplateId = templates[0].template_id;
    createTemplateOverrides = {};
  }
  select.innerHTML = templates.map((item) => {
    const display = templateDisplay(item, getLanguage());
    return '<option value="' + h(item.template_id) + '">' + h(display.name) + '</option>';
  }).join("");
  select.value = createTemplateId;
  select.disabled = !writable();

  const template = selectedCreateTemplate();
  const display = templateDisplay(template, getLanguage());
  description.textContent = display.description;
  const sshPath = "providers.tailscale.ssh";
  const sshAllowed = template.allowed_override_paths?.includes(sshPath);
  const defaultSsh = template.effective_posture?.providers?.tailscale?.ssh === true;
  const sshValue = Object.hasOwn(createTemplateOverrides, sshPath) ? createTemplateOverrides[sshPath] : defaultSsh;
  options.innerHTML = sshAllowed
    ? '<label class="template-option"><input id="template-tailscale-ssh" type="checkbox"' + (sshValue ? " checked" : "") + (writable() ? "" : " disabled") + '><span>' + text("tailscaleSshOption") + '</span></label>'
    : "";

  const summary = templatePostureSummary(template, createTemplateOverrides);
  const yesNo = (value) => text(value ? "enabled" : "disabled");
  preview.innerHTML = '<dl>' +
    '<dt>' + text("tailscale") + '</dt><dd>' + yesNo(summary.tailscale_enabled) + '</dd>' +
    '<dt>' + text("tailscaleSsh") + '</dt><dd>' + yesNo(summary.tailscale_ssh) + '</dd>' +
    '<dt>' + text("jitPrivilege") + '</dt><dd>' + yesNo(summary.privilege_broker && summary.privileged_helper) + '</dd>' +
    '<dt>' + text("breakGlass") + '</dt><dd>' + yesNo(summary.break_glass) + '</dd>' +
    '<dt>' + text("acceptanceMode") + '</dt><dd>' + h(summary.consumer_acceptance) + '</dd>' +
    '<dt>' + text("rootCeremony") + '</dt><dd>' + h(summary.root_ceremony) + '</dd>' +
    '</dl>';
}
function clearBootstrapDelivery() {
  const command = $("#bootstrap-command");
  const code = $("#bootstrap-code");
  const expiry = $("#bootstrap-expiry");
  if (command) command.value = "";
  if (code) code.value = "";
  if (expiry) expiry.textContent = "";
}
function showBootstrapDelivery(delivery) {
  if (!delivery?.command || !delivery?.short_code) throw new Error("TICKET_DELIVERY_INVALID");
  if ($("#detail-dialog").open) $("#detail-dialog").close();
  $("#bootstrap-command").value = delivery.command;
  $("#bootstrap-code").value = delivery.short_code;
  $("#bootstrap-expiry").textContent = delivery.expires_at ? date(delivery.expires_at, true) : "";
  $("#bootstrap-dialog").showModal();
  $("#bootstrap-command").focus();
}
async function copyBootstrapField(id) {
  const field = $("#" + id);
  if (!field?.value) return;
  try { await navigator.clipboard.writeText(field.value); }
  catch { field.focus(); field.select?.(); }
}

function createTemplateSelection() {
  const template = selectedCreateTemplate();
  if (!template) throw new Error("TEMPLATE_NOT_FOUND");
  return templateSelectionPayload(template, createTemplateOverrides);
}

function inspectButton(kind, id, label = "viewDetails") {
  return '<button type="button" class="btn btn-outline-secondary" data-open-kind="' + kind + '" data-open-id="' + h(id) + '">' + text(label) + "</button>";
}
function nameButton(kind, id, name) {
  return '<button type="button" class="row-name" title="' + h(name) + '" data-open-kind="' + kind + '" data-open-id="' + h(id) + '">' + h(name) + "</button>";
}
function nodeCells(node) {
  return "<td>" + nameButton("node", node.node_uid, node.node_id) + '<div class="record-id table-id" title="' + h(node.node_uid) + '">' + h(node.node_uid) + "</div>" +
    (synthetic(node) ? '<span class="simulation" title="' + text("simulation") + '">' + text("simulationShort") + "</span>" : "") +
    "</td><td>" + badge(node.lifecycle) + "</td><td>" + h(node.platform) + "</td>";
}
function renderOverview() {
  const waiting = snapshot.gates.filter(gateActionable);
  const active = activeAttempts();
  const queue = [
    ...waiting.map((gate) => ({ kind: "gate", id: gate.gate_id, name: attemptName(attemptFor(gate), gate.subject_id), symbol: "approvals", detail: t("needsApproval") })),
    ...active.filter((attempt) => ["CREATED", "PREPARING", "CLAIMED", "RECONCILE_REQUIRED"].includes(attempt.state)).slice().reverse().map((attempt) =>
      ({ kind: "attempt", id: attempt.attempt_id, name: attemptName(attempt), symbol: "enrollment", detail: t("state." + attempt.state) + " · " + t("continueEnrollment") })),
  ];
  const latestNodes = snapshot.nodes.slice().sort((a, b) => Date.parse(b.admitted_at) - Date.parse(a.admitted_at)).slice(0, 5);
  const summary = [[snapshot.nodes.length, "summaryNodes"], [active.length, "summaryActive"], [waiting.length, "summaryGates"]].map(([count, key]) =>
    "<span><strong>" + h(count) + "</strong>" + text(key) + "</span>").join("");
  const devices = latestNodes.length ? '<div class="data-frame"><div class="table-scroll" tabindex="0" role="region" aria-label="' + text("recentDevices") + '"><table class="data-table"><thead><tr><th scope="col">' + text("device") + '</th><th scope="col">' + text("lifecycle") + '</th><th scope="col">' + text("platform") + '</th></tr></thead><tbody>' +
    latestNodes.map((node) => "<tr>" + nodeCells(node) + "</tr>").join("") + "</tbody></table></div></div>" : empty("emptyNodesTitle", "emptyNodes");
  const work = queue.length ? queue.slice(0, 5).map((item) =>
    '<button type="button" class="queue-item" data-open-kind="' + item.kind + '" data-open-id="' + h(item.id) + '">' + icon(item.symbol) +
    "<span><strong>" + h(item.name) + '</strong><span class="secondary">' + h(item.detail) + "</span></span></button>").join("") : empty("emptyTodoTitle", "emptyTodoHelp", "check");
  const events = snapshot.events.slice(-4).reverse();
  const activity = events.length ? '<ul class="activity-list">' + events.map((event) =>
    '<li class="activity-item"><div><strong>' + text("event." + event.type) + '</strong><span class="secondary">' + h(subjectName(event.subject)) +
    (event.data?.to ? " · " + text("state." + event.data.to) : "") + '</span></div><time datetime="' + h(event.at) + '">' + h(date(event.at)) + "</time></li>").join("") + "</ul>" : empty("emptyEventsTitle", "emptyEvents", "activity");
  return '<div class="overview-summary">' + summary + '</div><div class="overview-layout"><div class="overview-main"><div class="section-heading"><h2>' + text("recentDevices") + '</h2><a class="text-link" href="#devices">' + text("viewAll") + "</a></div>" + devices +
    '<section class="overview-activity"><div class="section-heading"><h2>' + text("events") + '</h2><a class="text-link" href="#activity">' + text("viewAll") + "</a></div>" + activity +
    '</section></div><section class="queue"><div class="queue-heading"><h2>' + text("todo") + '</h2><span class="secondary">' + h(queue.length) + "</span></div>" + work + (queue.length > 5 ? '<a class="text-link" href="#enrollment">' + text("viewAll") + "</a>" : "") + "</section></div>";
}

const tables = {
  devices: { kind: "node", id: (row) => row.node_uid, data: () => snapshot.nodes, name: (row) => row.node_id, status: (row) => row.lifecycle, category: () => "all",
    states: ["ACTIVE", "PROVISIONAL", "SUSPENDED", "RETIRED"], columns: [["name", "device", true], ["state", "lifecycle", true], ["platform", "platform", true, true], ["date", "admitted", true, true]],
    date: (row) => row.admitted_at, empty: ["emptyNodesTitle", "emptyNodes"] },
  enrollment: { kind: "attempt", id: (row) => row.attempt_id, data: () => snapshot.attempts, name: (row) => attemptName(row), status: attemptState,
    category: (row) => finalStates.has(row.state) || expired(row) ? "completed" : "current",
    states: ["CREATED", "PREPARING", "WAITING_HUMAN", "CLAIMED", "MATERIALIZING", "RECONCILE_REQUIRED", "ACCEPTED", "FAILED", "CANCELLED", "EXPIRED"],
    columns: [["name", "device", true], ["state", "lifecycle", true], ["evidence", "evidence", false, true], ["date", "createdAt", true, true]],
    date: (row) => row.created_at, empty: ["emptyAttemptsTitle", "emptyAttempts"] },
  approvals: { kind: "gate", id: (row) => row.gate_id, data: () => snapshot.gates, name: (row) => attemptName(attemptFor(row), row.subject_id), status: gateState,
    category: (row) => gateActionable(row) ? "pending" : "resolved", states: ["WAITING", "APPROVED", "REJECTED", "EXPIRED"],
    columns: [["name", "device", true], ["state", "lifecycle", true], ["prompt", "request", false, true], ["date", "expiresAt", true, true]],
    date: (row) => row.expires_at, empty: ["emptyGatesTitle", "emptyGates"] },
  capabilities: { kind: "capability", id: (row) => row.id, data: () => snapshot.capabilities, name: (row) => row.id, status: (row) => row.risk, category: () => "all", states: ["R0", "R1", "R2"],
    columns: [["name", "capabilities", true], ["state", "risk", true], ["description", "descriptionLabel", false, true]], date: () => null, empty: ["emptyCapsTitle", "emptyCaps"] },
  activity: { kind: "event", id: (row) => row.event_id, data: () => snapshot.events, name: (row) => t("event." + row.type), status: (row) => row.type, category: () => "all",
    states: ["EnrollmentAttemptChanged", "HumanGateRequired", "HumanGateResolved", "EvidenceUpdated", "NodeAdmitted", "ReconcileRequired", "CapabilityAvailable", "CapabilityRequested", "CapabilityGranted", "ProjectionStale"],
    columns: [["name", "eventType", true], ["subject", "subject", true], ["date", "time", true, true]], date: (row) => row.at, empty: ["emptyEventsTitle", "emptyEvents"] },
};
function filterLabel(state) { return view === "capabilities" ? t("risk" + state) : view === "activity" ? t("event." + state) : t("state." + state); }
function tableAdapter(config) {
  return {
    searchText: (row) => [config.name(row), config.id(row), config.status(row), filterLabel(config.status(row)), row.platform, row.subject_id, row.description, row.prompt, row.subject, row.type].filter((value) => value != null).join(" "),
    statusOf: config.status, categoryOf: config.category,
    valueOf: (row, key) => key === "name" ? config.name(row) : key === "state" ? filterLabel(config.status(row)) : key === "date" ? Number.isFinite(Date.parse(config.date(row))) ? Date.parse(config.date(row)) : null : key === "subject" ? subjectName(row.subject) : row[key],
  };
}
function renderTablePage() {
  const state = tableStates[view], config = tables[view];
  const tabs = view === "enrollment" ? ["current", "all", "completed"] : view === "approvals" ? ["pending", "all", "resolved"] : [];
  const tabMarkup = tabs.length ? '<div class="view-tabs" role="tablist" aria-label="' + text(view) + '">' + tabs.map((tab) =>
    '<button type="button" class="view-tab" id="tab-' + tab + '" data-tab="' + tab + '" role="tab" aria-controls="records-panel" aria-selected="' + (state.tab === tab) + '" tabindex="' + (state.tab === tab ? "0" : "-1") + '">' + text(tab) + "</button>").join("") + "</div>" : "";
  const columns = config.columns.filter((column) => !state.hidden.has(column[0]));
  return tabMarkup + '<div id="records-panel"' + (tabs.length ? ' role="tabpanel" aria-labelledby="tab-' + state.tab + '"' : "") + '><div class="table-toolbar">' +
    '<label class="visually-hidden" for="table-search">' + text("searchRecords") + '</label><input type="search" id="table-search" class="form-control" autocomplete="off" placeholder="' + text("searchRecords") + '" value="' + h(state.query) + '">' +
    '<label class="visually-hidden" for="table-status">' + text(view === "capabilities" ? "risk" : view === "activity" ? "eventType" : "lifecycle") + '</label><select id="table-status" class="form-select"><option value="">' + text(view === "capabilities" ? "allRisks" : view === "activity" ? "allEvents" : "allStatuses") + "</option>" +
    config.states.map((status) => '<option value="' + h(status) + '"' + (state.status === status ? " selected" : "") + ">" + h(filterLabel(status)) + "</option>").join("") + "</select>" +
    (config.columns.some((column) => column[3]) ? '<details class="column-picker"><summary class="btn btn-outline-secondary">' + icon("columns") + text("columns") + '</summary><div class="column-options">' + config.columns.filter((column) => column[3]).map(([key, label]) =>
      '<label><input type="checkbox" data-column="' + key + '"' + (!state.hidden.has(key) ? " checked" : "") + ">" + text(label) + "</label>").join("") + "</div></details>" : "") + '</div><div class="data-frame"><div class="table-scroll" tabindex="0" role="region" aria-label="' + text("tableRegion", { name: t(view) }) + '"><table class="data-table"><thead><tr>' +
    columns.map(([key, label, sortable]) => '<th scope="col"' + (sortable ? ' aria-sort="' + (state.sortKey === key ? state.direction === "asc" ? "ascending" : "descending" : "none") + '"' : "") + ">" +
      (sortable ? '<button type="button" class="sort-button" data-sort="' + key + '" aria-label="' + text("sortBy", { column: t(label) }) + '">' + text(label) + icon(state.sortKey === key ? state.direction === "asc" ? "arrowUp" : "arrowDown" : "sort") + "</button>" : text(label)) + "</th>").join("") +
    '<th scope="col"><span class="visually-hidden">' + text("action") + '</span></th></tr></thead><tbody id="record-rows"></tbody></table></div></div><div id="pagination" class="pagination"></div></div>';
}
function renderCell(row, key, config) {
  if (key === "name") return nameButton(config.kind, config.id(row), config.name(row)) +
    '<div class="record-id table-id" title="' + h(config.id(row)) + '">' + h(config.id(row)) + "</div>" +
    ((view === "devices" && synthetic(row) || view === "enrollment" && syntheticEvidence(row)) ? '<span class="simulation" title="' + text("simulation") + '">' + text("simulationShort") + "</span>" : "");
  if (key === "state") return view === "capabilities" ? '<span class="state">' + text("risk" + row.risk) + "</span>" : badge(config.status(row));
  if (key === "date") return '<span class="date-cell" title="' + h(config.date(row)) + '">' + h(date(config.date(row))) + "</span>";
  if (key === "evidence") return text("evidenceCount", { passed: evidenceResults(row).passed, total: requiredEvidence.length });
  if (key === "prompt") return '<span class="row-name secondary" title="' + h(row.prompt || "") + '">' + (row.prompt === "Confirm enrollment" ? text("gateDefaultPrompt") : h(row.prompt)) + "</span>";
  if (key === "subject") return '<span class="row-name" title="' + h(row.subject) + '">' + h(subjectName(row.subject)) + "</span>";
  return h(row[key]);
}
function renderRows() {
  if (!tables[view] || !snapshot || !$("#record-rows")) return;
  const state = tableStates[view], config = tables[view];
  const selected = selectRows(config.data(), { ...state, locale: getLanguage() }, tableAdapter(config));
  state.page = selected.page;
  const columns = config.columns.filter((column) => !state.hidden.has(column[0]));
  $("#record-rows").innerHTML = selected.rows.length ? selected.rows.map((row) =>
    "<tr>" + columns.map(([key]) => "<td>" + renderCell(row, key, config) + "</td>").join("") + "<td>" + inspectButton(config.kind, config.id(row), view === "approvals" ? "viewRequest" : "viewDetails") + "</td></tr>").join("") :
    '<tr><td colspan="' + (columns.length + 1) + '">' + (config.data().length ? empty("noMatches", "noMatchesHelp", view, true) : empty(config.empty[0], config.empty[1], view)) + "</td></tr>";
  $("#pagination").innerHTML = '<span>' + text("paginationRange", selected) + '</span><div class="pagination-controls"><label class="pagination-size-label" for="page-size">' + text("rowsPerPage") +
    '</label><select id="page-size" class="form-select" aria-label="' + text("rowsPerPage") + '">' + [10, 25, 50].map((size) => '<option value="' + size + '"' + (selected.pageSize === size ? " selected" : "") + ">" + size + "</option>").join("") +
    "</select><span>" + text("pageCount", selected) + '</span><button class="btn icon-button" type="button" data-page="-1" aria-label="' + text("previousPage") + '"' + (selected.page === 1 ? " disabled" : "") + ">" + icon("left") +
    '</button><button class="btn icon-button" type="button" data-page="1" aria-label="' + text("nextPage") + '"' + (selected.page === selected.pages ? " disabled" : "") + ">" + icon("right") + "</button></div>";
}
function renderSettingsProviders() {
  const host = $("#providers-settings");
  if (!host) return;
  host.innerHTML = snapshot ? renderProviders(snapshot.providers) :
    '<section class="settings-section provider-card"><div class="settings-description"><h2>' + text("providers") +
    '</h2><p class="secondary">' + text("provider.settingsHelp") +
    '</p></div><div class="settings-form"><p class="secondary">' + text("provider.connectControlPlaneFirst") + '</p></div></section>';
}

function renderPage() {
  $("#settings-view").hidden = view !== "settings";
  $("#page-content").hidden = view === "settings";
  $("#page-content").setAttribute("aria-busy", String(busy));
  if (view === "settings") { $("#page-content").replaceChildren(); renderSettingsProviders(); return; }
  if (!snapshot) {
    $("#page-content").innerHTML = busy ? '<div class="data-frame">' + Array.from({ length: 5 }, () => '<div class="loading-row"><div class="loading-placeholder"></div></div>').join("") + "</div>" :
      '<section class="welcome">' + icon("devices") + "<h2>" + text("welcomeTitle") + "</h2><p>" + text("welcomeHelp") + '</p><button type="button" class="btn btn-primary" data-go="settings">' + text("connectControlPlane") + "</button></section>";
    return;
  }
  $("#page-content").innerHTML = view === "overview" ? renderOverview() : renderTablePage();
  renderRows();
}

function entryFor(kind, id) {
  if (!snapshot) return null;
  const names = { node: "devices", attempt: "enrollment", gate: "approvals", capability: "capabilities", event: "activity" };
  if (!Object.hasOwn(names, kind)) return null;
  const config = tables[names[kind]];
  return config.data().find((row) => config.id(row) === id) || null;
}
function fields(pairs) {
  return '<dl class="detail-fields">' + pairs.map(([label, value]) => "<dt>" + text(label) + "</dt><dd>" + h(value) + "</dd>").join("") + "</dl>";
}
function section(title, body) { return '<section class="detail-section"><h3>' + text(title) + "</h3>" + body + "</section>"; }
function attemptActions(attempt) {
  if (finalStates.has(attempt.state) || expired(attempt)) return "";
  const button = (action, label, primary = false) => '<button type="button" class="btn ' + (primary ? "btn-primary" : "btn-outline-secondary") +
    '" aria-label="' + h(t(label) + " · " + attemptName(attempt)) + '" data-attempt="' + h(attempt.attempt_id) + '" data-action="' + action + '"' + disabled() + ">" + text(label) + "</button>";
  if (attempt.state === "CREATED") return button("ticket", "generateBootstrap", true) + button("prepare", "prepare");
  if (attempt.state === "PREPARING") return button("ticket", "generateBootstrap", true) + button("human-gates", "requestGate") + button("claim", "claim");
  if (attempt.state === "CLAIMED") return button("materialize", "materialize", true);
  return "";
}
function progress(attempt) {
  if (["FAILED", "CANCELLED", "RECONCILE_REQUIRED"].includes(attempt.state) || attemptState(attempt) === "EXPIRED") return "";
  const stage = { CREATED: 0, PREPARING: 1, WAITING_HUMAN: 2, CLAIMED: 3, MATERIALIZING: 3, ACCEPTED: 5 }[attempt.state];
  return '<ol class="progress-steps" aria-label="' + text("enrollment") + '">' + ["created", "preparing", "claimed", "evidence", "accepted"].map((step, index) =>
    '<li class="' + (index < stage ? "done" : index === stage ? "current" : "") + '"' + (index === stage ? ' aria-current="step"' : "") + ">" + text("step." + step) + "</li>").join("") + "</ol>";
}
function evidence(attempt) {
  const { latest, passed } = evidenceResults(attempt);
  return section("evidence", (syntheticEvidence(attempt) ? '<p class="simulation evidence-simulation">' + text("simulation") + "</p>" : "") + '<p class="secondary">' + text("evidenceSummary", { passed, total: requiredEvidence.length }) + '</p><ul class="evidence-list">' + requiredEvidence.map((type) => {
    const item = latest.get(type), pass = item?.data?.status === "PASS";
    return '<li><span title="' + h(type) + '">' + text("evidence." + type) + '</span><span class="' + (pass ? "pass" : item ? "fail" : "secondary") + '">' + text(pass ? "evidencePass" : item ? "evidenceFail" : "evidenceMissing") + "</span></li>";
  }).join("") + "</ul>");
}
function detailBody(kind, row) {
  if (kind === "node") return '<h3 class="detail-title">' + h(row.node_id) + "</h3>" + badge(row.lifecycle) +
    (synthetic(row) ? '<p class="simulation">' + text("simulation") + "</p>" : "") +
    fields([["deviceUid", row.node_uid], ["platform", row.platform], ["admitted", date(row.admitted_at, true)], ["updatedAt", date(row.updated_at, true)]]) +
    '<p class="detail-message">' + text("lifecycleHelp") + "</p>" +
    section("relatedAttempt", inspectButton("attempt", row.enrollment_attempt_id));
  if (kind === "attempt") {
    const state = attemptState(row), actions = attemptActions(row);
    const gates = snapshot.gates.filter((gate) => gate.subject_id === row.attempt_id);
    const templateFields = row.template_binding ? [
      ["enrollmentTemplate", row.template_binding.template_id],
      ["templateGeneration", row.template_binding.template_generation],
      ["templateDigest", row.template_binding.template_digest],
    ] : [];
    return '<h3 class="detail-title">' + h(attemptName(row)) + "</h3>" + badge(state) +
      '<div class="record-id">' + h(row.attempt_id) + "</div>" + progress(row) +
      '<p class="detail-message">' + text(state === "EXPIRED" ? "nextExpired" : "next." + row.state) + "</p>" +
      (actions ? '<div class="record-actions">' + actions + "</div>" : "") +
      (!writable() && !finalStates.has(row.state) ? '<p class="permission-note">' + text(permissionKey()) + "</p>" : "") +
      fields([...templateFields, ["createdAt", date(row.created_at, true)], ["expiresAt", date(row.expires_at, true)], ["revision", row.revision]]) +
      (gates.length ? section("relatedApprovals", '<div class="detail-related">' + gates.map((gate) => inspectButton("gate", gate.gate_id, "viewRequest")).join("") + "</div>") : "") +
      evidence(row) + section("transitionHistory", row.history?.length ? '<ol class="detail-history">' + row.history.slice().reverse().map((change) =>
        "<li>" + text("state." + change.from) + " → " + text("state." + change.to) + '<span class="secondary">' + h(date(change.at, true)) + "</span></li>").join("") + "</ol>" : '<p class="secondary">' + text("noTransitions") + "</p>");
  }
  if (kind === "gate") {
    const attempt = attemptFor(row), actionable = gateActionable(row);
    const decisionButton = (decision, label, primary) => '<button type="button" class="btn ' + (primary ? "btn-primary" : "btn-outline-danger") +
      '" data-gate="' + h(row.gate_id) + '" data-decision="' + decision + '" aria-label="' + h(t(label) + " · " + attemptName(attempt, row.subject_id)) + '"' + disabled() + ">" + text(label) + "</button>";
    return '<h3 class="detail-title">' + h(attemptName(attempt, row.subject_id)) + "</h3>" + badge(gateState(row)) +
      '<p class="detail-message">' + (row.prompt === "Confirm enrollment" ? text("gateDefaultPrompt") : h(row.prompt || t("gateDefaultPrompt"))) + "</p>" +
      fields([["recordId", row.gate_id], ["subject", row.subject_id], ["createdAt", date(row.created_at, true)], ["expiresAt", date(row.expires_at, true)]]) +
      (actionable ? '<div class="record-actions">' + decisionButton("APPROVE", "approve", true) + decisionButton("REJECT", "reject", false) + "</div>" :
        '<p class="detail-message">' + text(gateState(row) === "EXPIRED" ? "gateUnavailable" : "gateNotActionable") + "</p>") +
      (actionable && !writable() ? '<p class="permission-note">' + text(permissionKey()) + "</p>" : "") +
      (attempt ? section("relatedAttempt", inspectButton("attempt", attempt.attempt_id)) : "");
  }
  if (kind === "capability") return '<h3 class="detail-title">' + h(row.id) + '</h3><span class="state">' + text("risk" + row.risk) +
    '</span><p class="detail-message">' + h(row.description) + '</p><p class="detail-message">' + text("capabilityScope") + "</p>";
  return '<h3 class="detail-title">' + text("event." + row.type) + "</h3>" +
    fields([["recordId", row.event_id], ["subject", subjectName(row.subject)], ["time", date(row.at, true)]]) +
    section("eventPayload", '<pre class="event-payload">' + h(JSON.stringify(row.data || {}, null, 2)) + "</pre>");
}
function renderDetail() {
  if (!$("#detail-dialog").open || !detailStack.length) return;
  const current = detailStack.at(-1), row = entryFor(current.kind, current.id);
  if (!row) { $("#detail-dialog").close(); return; }
  $("#detail-heading").textContent = t("details." + current.kind);
  $("#detail-back").hidden = detailStack.length < 2;
  $("#detail-content").innerHTML = detailBody(current.kind, row);
}
function openDetail(kind, id) {
  if (!entryFor(kind, id)) return;
  if ($("#search-dialog").open) $("#search-dialog").close();
  if ($("#detail-dialog").open) {
    const current = detailStack.at(-1);
    if (current.kind !== kind || current.id !== id) detailStack = [...detailStack.slice(-15), { kind, id }];
  } else {
    detailOrigin = { kind, id };
    detailStack = [{ kind, id }];
    $("#detail-dialog").showModal();
  }
  renderDetail();
  $("#detail-dialog [data-close-dialog]").focus({ preventScroll: true });
}
function commandEntries() {
  const pages = routes.map((route) => ({ route, name: t(route), subtitle: t("description." + route), symbol: route }));
  if (!snapshot) return pages;
  return [...pages,
    ...snapshot.nodes.map((row) => ({ kind: "node", id: row.node_uid, name: row.node_id, subtitle: t("devices") + " · " + row.node_uid, symbol: "devices" })),
    ...snapshot.gates.filter(gateActionable).map((row) => ({ kind: "gate", id: row.gate_id, name: attemptName(attemptFor(row), row.subject_id), subtitle: t("needsApproval") + " · " + row.gate_id, symbol: "approvals" })),
    ...snapshot.attempts.map((row) => ({ kind: "attempt", id: row.attempt_id, name: attemptName(row), subtitle: t("enrollment") + " · " + row.attempt_id, symbol: "enrollment" })),
    ...snapshot.capabilities.map((row) => ({ kind: "capability", id: row.id, name: row.id, subtitle: t("risk" + row.risk), symbol: "capabilities" })),
  ];
}
function renderCommands() {
  if (!$("#search-dialog").open) return;
  const query = $("#command-query").value.trim().toLocaleLowerCase(getLanguage());
  const entries = commandEntries().filter((entry) => String(entry.name + " " + entry.subtitle).toLocaleLowerCase(getLanguage()).includes(query)).slice(0, 30);
  $("#command-results").innerHTML = entries.length ? entries.map((entry) =>
    '<button type="button" class="command-result"' + (entry.route ? ' data-command-route="' + entry.route + '"' : ' data-open-kind="' + entry.kind + '" data-open-id="' + h(entry.id) + '"') + ">" +
    icon(entry.symbol) + "<span>" + h(entry.name) + "<small>" + h(entry.subtitle) + "</small></span></button>").join("") :
    '<div class="empty-state">' + text("commandEmpty") + "</div>";
}
function openSearch() {
  if ($("#detail-dialog").open || $("#create-dialog").open || $("#navigation-dialog").open) return;
  $("#command-query").value = "";
  $("#search-dialog").showModal();
  renderCommands();
  $("#command-query").focus();
}
function render() {
  const previous = document.activeElement;
  const focusedControl = ["table-search", "table-status", "page-size"].includes(previous?.id) ? previous.id : null;
  const selection = focusedControl === "table-search" ? [previous.selectionStart, previous.selectionEnd] : null;
  const menuOpen = $(".column-picker")?.open;
  const focusedSort = previous?.dataset.sort, focusedColumn = previous?.dataset.column;
  const focusedAction = previous?.dataset.attempt || previous?.dataset.gate;
  renderShell();
  renderPage();
  if (menuOpen && $(".column-picker")) $(".column-picker").open = true;
  renderDetail();
  renderCommands();
  renderFeedback();
  if (previous && !previous.isConnected) {
    const replacement = focusedControl ? $("#" + focusedControl) : focusedSort ? $('[data-sort="' + CSS.escape(focusedSort) + '"]') :
      focusedColumn ? $('[data-column="' + CSS.escape(focusedColumn) + '"]') :
      focusedAction && $("#detail-dialog").open ? $("#detail-content .record-actions button:not(:disabled)") || $("#detail-dialog [data-close-dialog]") : null;
    replacement?.focus({ preventScroll: true });
    if (selection && replacement?.setSelectionRange) replacement.setSelectionRange(...selection);
  }
}
function navigate(next) {
  if (!routes.includes(next)) return;
  if ($("#navigation-dialog").open) $("#navigation-dialog").close();
  if ($("#search-dialog").open) $("#search-dialog").close();
  if (view === next) { render(); $("#page-title").focus({ preventScroll: true }); }
  else location.hash = next;
}
function clearSession() {
  epoch += 1;
  session.abort();
  session = new AbortController();
  accessToken = ""; access = null; snapshot = null; lastRead = null;
  busy = false; uncertain = false; detailStack = [];
  tableStates = createTableStates();
  createTemplateId = ""; createTemplateOverrides = {};
  $("#api-token").value = "";
  $("#command-query").value = "";
  $("#command-results").replaceChildren();
  $("#new-attempt").reset();
  clearBootstrapDelivery();
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
  $("#detail-content").replaceChildren();
}
function errorKey(error, connecting = false) {
  if (error.message === "UNAUTHORIZED") return "errorUnauthorized";
  if (error.message === "AUTH_NOT_CONFIGURED") return "errorConfig";
  if (error.message === "READ_ONLY_CREDENTIAL") return "errorReadOnly";
  if (error.message === "PROVIDER_CLAIM_MATERIAL_UNAVAILABLE") return "providerGateNeeded";
  if (error.message === "TICKET_ALREADY_ISSUED" || error.message === "TICKET_NOT_REVOCABLE") return "errorConflict";
  if (error.message.includes("EXPIRED")) return "errorExpired";
  if (error.message === "ACCEPTANCE_EVIDENCE_MISSING") return "errorEvidence";
  if (error.message.includes("STATE") || error.message.includes("RESOLVED") || error.message.includes("TRANSITION") || error.message === "HUMAN_GATE_APPROVAL_REQUIRED") return "errorConflict";
  if (error.message === "NETWORK_ERROR") return connecting ? "errorConnectNetwork" : "errorNetwork";
  return "errorRequest";
}
async function task(action, { mutation = false, success = "updatedNotice", connecting = false, onSuccess } = {}) {
  if (busy) return;
  const ownEpoch = epoch;
  busy = true; feedback = null; render();
  let changed = false;
  try {
    const result = action ? await action() : null;
    changed = !!action && mutation;
    const next = await readSnapshot();
    if (ownEpoch !== epoch) return;
    snapshot = next; access = next.access; lastRead = new Date().toISOString(); uncertain = false;
    showFeedback(success, "success");
    render();
    onSuccess?.(result);
  } catch (error) {
    if (ownEpoch !== epoch) return;
    const key = mutation && (changed || error.ambiguous) ? "errorAmbiguous" : errorKey(error, connecting);
    if (error.message === "UNAUTHORIZED" || connecting) { clearSession(); navigate("settings"); }
    else if (mutation && (changed || error.ambiguous)) uncertain = true;
    showFeedback(key, "error");
  } finally {
    if (ownEpoch === epoch) { busy = false; render(); }
    else if (!accessToken) render();
  }
}

window.addEventListener("hashchange", () => {
  const next = location.hash.slice(1);
  if (!routes.includes(next)) return;
  view = next;
  if ($("#navigation-dialog").open) $("#navigation-dialog").close();
  render();
  $("#page-title").focus({ preventScroll: true });
});
$("#connect").addEventListener("submit", (event) => {
  event.preventDefault();
  if (busy) return;
  const token = $("#api-token").value.trim();
  clearSession(); accessToken = token;
  task(null, { connecting: true, success: "connectedNotice", onSuccess: () => navigate("overview") });
});
$("#disconnect").addEventListener("click", () => {
  clearSession(); showFeedback("disconnectedNotice"); render(); $("#api-token").focus();
});
$("#refresh").addEventListener("click", () => task(null, { success: "refreshedNotice" }));
$("#session-link").addEventListener("click", () => navigate("settings"));
$("#open-create").addEventListener("click", () => {
  if (!writable()) return;
  feedback = null; renderFeedback();
  renderCreateTemplateControls();
  $("#create-dialog").showModal(); $("#asset-hint").focus();
});
$("#new-attempt").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!writable()) return;
  const asset_hint = $("#asset-hint").value.trim();
  if (!asset_hint) { $("#asset-hint").focus(); return; }
  let template_selection;
  try { template_selection = createTemplateSelection(); }
  catch { $("#template-select").focus(); return; }
  task(() => post("/v0/enrollment-attempts", { asset_hint, template_selection }), {
    mutation: true, success: "createdNotice",
    onSuccess: (result) => {
      const stillOpen = $("#create-dialog").open;
      $("#new-attempt").reset();
      createTemplateId = ""; createTemplateOverrides = {};
      if (stillOpen) { $("#create-dialog").close(); navigate("enrollment"); openDetail("attempt", result.attempt.attempt_id); }
    },
  });
});
$("#language").addEventListener("change", (event) => { setLanguage(event.target.value); render(); renderCreateTemplateControls(); });
$("#template-select").addEventListener("change", (event) => { createTemplateId = event.target.value; createTemplateOverrides = {}; renderCreateTemplateControls(); });
$("#template-options").addEventListener("change", (event) => {
  if (event.target.id === "template-tailscale-ssh") {
    createTemplateOverrides = { ...createTemplateOverrides, "providers.tailscale.ssh": event.target.checked };
    renderCreateTemplateControls();
  }
});
$("#theme-toggle").addEventListener("click", () => appearance.setPreference(appearance.isDark() ? "light" : "dark"));
$("#theme-preference").addEventListener("change", (event) => appearance.setPreference(event.target.value));
window.addEventListener("ghostfleet-appearance", renderShell);
$("#navigation-toggle").addEventListener("click", () => {
  if (innerWidth <= 900) $("#navigation-dialog").showModal();
  else {
    const compact = document.documentElement.dataset.navigation !== "compact";
    document.documentElement.dataset.navigation = compact ? "compact" : "full";
    try { localStorage.setItem("ghostfleet-nav-collapsed", String(compact)); } catch {}
  }
  renderShell();
});
$("#navigation-dialog").addEventListener("close", renderShell);
$("#open-search").addEventListener("click", openSearch);
$("#command-query").addEventListener("input", renderCommands);
$("#detail-back").addEventListener("click", () => { if (detailStack.length > 1) { detailStack.pop(); renderDetail(); } });
$("#bootstrap-dialog").addEventListener("close", clearBootstrapDelivery);
$("#detail-dialog").addEventListener("close", () => {
  detailStack = [];
  $("#detail-content").replaceChildren();
  const target = detailOrigin && $('[data-open-kind="' + detailOrigin.kind + '"][data-open-id="' + CSS.escape(detailOrigin.id) + '"]');
  (target?.getClientRects().length ? target : $("#page-title")).focus({ preventScroll: true });
  detailOrigin = null;
});
for (const dialog of document.querySelectorAll("dialog")) dialog.addEventListener("click", (event) => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
});

document.addEventListener("input", (event) => {
  if (event.target.id === "table-search" && tables[view]) {
    tableStates[view].query = event.target.value; tableStates[view].page = 1; renderRows();
  }
});
document.addEventListener("change", (event) => {
  if (!tables[view] || !snapshot) return;
  if (event.target.id === "table-status") { tableStates[view].status = event.target.value; tableStates[view].page = 1; renderRows(); }
  if (event.target.id === "page-size") {
    tableStates[view].pageSize = Number(event.target.value); tableStates[view].page = 1; renderRows(); $("#page-size").focus();
  }
  if (event.target.dataset.column && tables[view].columns.some((column) => column[0] === event.target.dataset.column && column[3])) {
    const key = event.target.dataset.column;
    if (event.target.checked) tableStates[view].hidden.delete(key); else tableStates[view].hidden.add(key);
    render();
  }
});
document.addEventListener("click", (event) => {
  const skip = event.target.closest(".skip-link");
  if (skip) { event.preventDefault(); $("#main").focus(); return; }
  const navigationLink = event.target.closest(".nav-link, .brand");
  if (navigationLink && routes.includes(navigationLink.hash.slice(1))) { event.preventDefault(); navigate(navigationLink.hash.slice(1)); return; }
  const button = event.target.closest("button");
  if (!event.target.closest(".column-picker") && $(".column-picker")) $(".column-picker").open = false;
  if (!button || button.disabled) return;
  if (button.dataset.providerSetup === "tailscale") {
    $("#provider-setup-dialog")?.showModal();
    $("#provider-setup-dialog [data-close-dialog]")?.focus({ preventScroll: true });
    return;
  }
  if (button.dataset.copyTarget) { copyBootstrapField(button.dataset.copyTarget); return; }
  if (button.dataset.closeDialog) { $("#" + button.dataset.closeDialog)?.close(); return; }
  if (button.hasAttribute("data-refresh-state")) {
    const recoveringCreation = uncertain && $("#create-dialog").open;
    task(null, { success: "refreshedNotice", onSuccess: () => {
      if (recoveringCreation && $("#create-dialog").open) { $("#create-dialog").close(); navigate("enrollment"); }
    } });
    return;
  }
  if (button.dataset.go || button.dataset.commandRoute) { navigate(button.dataset.go || button.dataset.commandRoute); return; }
  if (button.dataset.openKind) { openDetail(button.dataset.openKind, button.dataset.openId); return; }
  if (tables[view] && snapshot) {
    if (button.dataset.tab) {
      const choices = view === "enrollment" ? ["current", "all", "completed"] : ["pending", "all", "resolved"];
      if (!choices.includes(button.dataset.tab)) return;
      tableStates[view].tab = button.dataset.tab; tableStates[view].page = 1; render();
      $('[data-tab="' + button.dataset.tab + '"]')?.focus();
      return;
    }
    if (button.dataset.sort && tables[view].columns.some((column) => column[0] === button.dataset.sort && column[2])) {
      const state = tableStates[view];
      state.direction = state.sortKey === button.dataset.sort && state.direction === "asc" ? "desc" : "asc";
      state.sortKey = button.dataset.sort; state.page = 1; render(); return;
    }
    if (button.dataset.page) { tableStates[view].page += Number(button.dataset.page); renderRows(); $("#table-search").focus({ preventScroll: true }); return; }
    if (button.hasAttribute("data-reset-filters")) { Object.assign(tableStates[view], { query: "", status: "", page: 1, tab: "all" }); render(); $("#table-search").focus(); return; }
  }
  if (!writable()) return;
  if (button.dataset.attempt) {
    const { attempt: id, action } = button.dataset;
    const attempt = entryFor("attempt", id);
    if (!attempt || expired(attempt)) { showFeedback("errorExpired", "error"); render(); return; }
    if (!["prepare", "human-gates", "claim", "materialize", "ticket"].includes(action)) return;
    const path = action === "ticket"
      ? "/v0/enrollment-attempts/" + encodeURIComponent(id) + "/ticket"
      : "/v0/enrollment-attempts/" + encodeURIComponent(id) + "/" + action;
    const payload = action === "ticket" ? { replace: true } : {};
    task(() => post(path, payload), {
      mutation: true,
      onSuccess: (result) => {
        if (action === "human-gates" && $("#detail-dialog").open && detailStack.at(-1)?.id === id) openDetail("gate", result.gate.gate_id);
        if (action === "ticket") showBootstrapDelivery(result.delivery);
      },
    });
  } else if (button.dataset.gate) {
    const { gate: id, decision } = button.dataset, gate = entryFor("gate", id);
    if (!gate || !gateActionable(gate)) { showFeedback("errorConflict", "error"); render(); return; }
    if (!["APPROVE", "REJECT"].includes(decision)) return;
    task(() => post("/v0/human-gates/" + encodeURIComponent(id) + "/resolve", { decision }), {
      mutation: true,
      onSuccess: () => {
        if (decision === "APPROVE" && $("#detail-dialog").open && detailStack.at(-1)?.id === id) openDetail("attempt", gate.subject_id);
      },
    });
  }
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); openSearch(); return; }
  if ($("#search-dialog").open && ["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) {
    const results = [...document.querySelectorAll(".command-result")];
    const index = results.indexOf(document.activeElement);
    if (event.key === "Enter" && document.activeElement === $("#command-query")) { event.preventDefault(); results[0]?.click(); return; }
    if (event.key !== "Enter" && results.length) {
      event.preventDefault();
      const next = index < 0 ? event.key === "ArrowDown" ? 0 : results.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
      results[next].focus();
    }
  }
  const tab = event.target.closest("[data-tab]");
  if (tab && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
    const tabs = [...document.querySelectorAll("[data-tab]")], index = tabs.indexOf(tab);
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault(); tabs[next].click();
  }
  if (event.key === "Escape" && $(".column-picker")?.open) { $(".column-picker").open = false; $(".column-picker summary").focus(); }
});
for (const node of document.querySelectorAll("[data-icon]")) node.innerHTML = icon(node.dataset.icon);
applyLocale();
render();
