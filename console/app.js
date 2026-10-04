import { applyLocale, getLanguage, setLanguage, t } from "./i18n.js";
import { DEFAULT_ACCEPTANCE_EVIDENCE as requiredEvidence } from "./model.js";

// Display metadata only. The server owns transitions, evidence and authorization.
const finalStates = new Set(["ACCEPTED", "CANCELLED", "FAILED"]);
let accessToken = "";
let access = null;
let snapshot = null;
let busy = false;
let uncertain = false;
let epoch = 0;
let session = new AbortController();
let feedback = null;
const $ = (selector) => document.querySelector(selector);
const h = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const text = (key, values) => h(t(key, values));
const expired = (record) => Date.parse(record?.expires_at) <= Date.now();
const writable = () => access === "operator" && !busy && !uncertain;
const disabled = () => writable() ? "" : " disabled";

function date(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return t("unknown");
  return new Intl.DateTimeFormat(getLanguage(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function badge(state, isExpired = false) {
  const actual = isExpired ? "EXPIRED" : state;
  const tone = ["ACCEPTED", "ACTIVE", "APPROVED"].includes(actual) ? "success"
    : ["WAITING_HUMAN", "WAITING", "RECONCILE_REQUIRED", "EXPIRED"].includes(actual) ? "warning"
    : ["FAILED", "REJECTED"].includes(actual) ? "danger"
    : ["PREPARING", "CLAIMED", "MATERIALIZING"].includes(actual) ? "info" : "";
  return '<span class="state ' + tone + '" title="' + h(state) + '">' + text("state." + actual) + "</span>";
}

function empty(title, description) {
  return '<div class="empty"><strong>' + text(title) + "</strong>" + text(description) + "</div>";
}

function showFeedback(key, tone = "", values = {}) {
  feedback = { key, tone, values };
  renderFeedback();
}

function renderFeedback() {
  $("#feedback").hidden = !feedback;
  $("#feedback").className = "feedback " + (feedback?.tone || "");
  $("#feedback").textContent = feedback ? t(feedback.key, feedback.values) : "";
}

async function api(path, options = {}) {
  const mutation = options.method === "POST";
  let response, data;
  try {
    response = await fetch(path, {
      ...options, cache: "no-store",
      signal: AbortSignal.any([session.signal, AbortSignal.timeout(15000)]),
      headers: { "content-type": "application/json", authorization: "Bearer " + accessToken },
    });
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
  const [permissions, attempts, gates, nodes, events, capabilities] = await Promise.all([
    api("/v0/access"), api("/v0/enrollment-attempts"), api("/v0/human-gates"),
    api("/v0/nodes"), api("/v0/events"), api("/v0/capabilities"),
  ]);
  if (!["operator", "read_only"].includes(permissions.access)) throw new Error("UNAUTHORIZED");
  return { access: permissions.access, attempts: attempts.attempts, gates: gates.gates, nodes: nodes.nodes, events: events.events, capabilities: capabilities.capabilities };
}

function gateActionable(gate) {
  const attempt = snapshot.attempts.find((item) => item.attempt_id === gate.subject_id);
  return gate.state === "WAITING" && !expired(gate) && attempt?.state === "WAITING_HUMAN" && !expired(attempt);
}

function attemptActions(attempt) {
  if (finalStates.has(attempt.state) || expired(attempt)) return "";
  const button = (action, label, primary = false) => '<button type="button" class="btn ' + (primary ? "btn-outline-primary" : "btn-outline-secondary") + '" aria-label="' + h(t(label) + " · " + (attempt.asset_hint || attempt.attempt_id)) + '" data-attempt="' + h(attempt.attempt_id) + '" data-action="' + action + '"' + disabled() + ">" + text(label) + "</button>";
  if (attempt.state === "CREATED") return button("prepare", "prepare", true);
  if (attempt.state === "PREPARING") return button("human-gates", "requestGate", true) + button("claim", "claim");
  if (attempt.state === "CLAIMED") return button("materialize", "materialize", true);
  return "";
}

function progress(attempt) {
  if (["FAILED", "CANCELLED", "RECONCILE_REQUIRED"].includes(attempt.state) || (!finalStates.has(attempt.state) && expired(attempt))) return "";
  const stage = { CREATED: 0, PREPARING: 1, WAITING_HUMAN: 2, CLAIMED: 3, MATERIALIZING: 3, ACCEPTED: 5 }[attempt.state];
  return '<ol class="progress-steps" aria-label="' + text("enrollment") + '">' +
    ["created", "preparing", "claimed", "evidence", "accepted"].map((step, index) =>
      '<li class="' + (index < stage ? "done" : index === stage ? "current" : "") + '"' +
      (index === stage ? ' aria-current="step"' : "") + ">" + text("step." + step) + "</li>").join("") + "</ol>";
}

function evidence(attempt) {
  if (!["MATERIALIZING", "ACCEPTED", "RECONCILE_REQUIRED"].includes(attempt.state) && !attempt.evidence?.length) return "";
  const latest = new Map((attempt.evidence || []).map((item) => [item.type, item]));
  const passed = requiredEvidence.filter((type) => latest.get(type)?.data?.status === "PASS").length;
  return '<details class="evidence"><summary>' + text("evidenceSummary", { passed, total: requiredEvidence.length }) + '</summary><ul class="evidence-list">' +
    requiredEvidence.map((type) => {
      const item = latest.get(type);
      const pass = item?.data?.status === "PASS";
      return '<li><span title="' + h(type) + '">' + text("evidence." + type) + '</span><span class="' + (pass ? "pass" : item ? "fail" : "secondary") + '">' + text(pass ? "evidencePass" : item ? "evidenceFail" : "evidenceMissing") + "</span></li>";
    }).join("") + "</ul></details>";
}

function renderAttempt(attempt) {
  const isExpired = !finalStates.has(attempt.state) && expired(attempt);
  const actions = attemptActions(attempt);
  return '<article class="record" tabindex="-1" data-record-id="' + h(attempt.attempt_id) + '"><div class="record-header"><div><h3 class="record-name">' +
    h(attempt.asset_hint || attempt.attempt_id) + '</h3><div class="record-id">' + h(attempt.attempt_id) +
    "</div></div>" + badge(attempt.state, isExpired) + "</div>" + progress(attempt) +
    '<p class="record-next">' + text(isExpired ? "nextExpired" : "next." + attempt.state) + "</p>" +
    (!finalStates.has(attempt.state) && !isExpired ? '<div class="secondary" title="' + h(attempt.expires_at) + '">' + text("expires", { time: date(attempt.expires_at) }) + "</div>" : "") +
    (actions ? '<div class="record-actions">' + actions + "</div>" : "") + evidence(attempt) + "</article>";
}

function renderGate(gate, pending) {
  const attempt = snapshot.attempts.find((item) => item.attempt_id === gate.subject_id);
  const isExpired = gate.state === "WAITING" && (expired(gate) || expired(attempt));
  const controls = pending ? '<div class="record-actions"><button type="button" class="btn btn-primary" data-gate="' + h(gate.gate_id) + '" data-decision="APPROVE"' + disabled() + ">" + text("approve") + '</button><button type="button" class="btn btn-outline-danger" data-gate="' + h(gate.gate_id) + '" data-decision="REJECT"' + disabled() + ">" + text("reject") + "</button></div>" : "";
  return '<article class="gate-record"><div class="record-header"><h3 class="record-name">' + h(attempt?.asset_hint || gate.subject_id) +
    "</h3>" + badge(gate.state, isExpired) + '</div><div class="record-id">' + h(gate.subject_id) + "</div>" +
    (pending ? '<p class="gate-prompt">' + (gate.prompt === "Confirm enrollment" ? text("gateDefaultPrompt") : h(gate.prompt || t("gateDefaultPrompt"))) +
      '</p><div class="secondary" title="' + h(gate.expires_at) + '">' + text("expires", { time: date(gate.expires_at) }) + "</div>" : "") +
    (isExpired ? '<p class="record-next">' + text("gateUnavailable") + "</p>" : "") + controls + "</article>";
}

function renderData() {
  const connected = !!snapshot;
  const disconnectedEmpty = () => empty("emptyDisconnectedTitle", "emptyDisconnected");
  if (!connected) {
    $("#summary").textContent = t("summaryDisconnected");
    for (const id of ["attempts", "gates", "capabilities", "events"]) {
      $("#" + id).innerHTML = busy ? '<div class="empty"><div class="loading-placeholder"></div><div class="loading-placeholder"></div></div>' : disconnectedEmpty();
    }
    $("#nodes").innerHTML = '<tr><td colspan="4">' + disconnectedEmpty() + "</td></tr>";
    $("#attempt-count").textContent = "";
    $("#node-count").textContent = "";
    $("#gate-count").textContent = "0";
    return;
  }
  const { attempts, gates, nodes, events, capabilities } = snapshot;
  const waiting = gates.filter(gateActionable);
  const historicalGates = gates.filter((gate) => !gateActionable(gate)).reverse();
  $("#summary").innerHTML = [[nodes.length, "summaryNodes"], [attempts.length, "summaryAttempts"], [waiting.length, "summaryGates"]]
    .map(([count, key]) => "<span><strong>" + h(count) + "</strong>" + text(key) + "</span>").join("");
  $("#attempt-count").textContent = t("records", { count: attempts.length });
  $("#node-count").textContent = t("nodeCount", { count: nodes.length });
  $("#gate-count").textContent = String(waiting.length);
  const current = attempts.filter((item) => !finalStates.has(item.state) && !expired(item)).reverse();
  const historical = attempts.filter((item) => finalStates.has(item.state) || expired(item)).reverse();
  $("#attempts").innerHTML = (current.length ? current.map(renderAttempt).join("") : empty("emptyAttemptsTitle", access === "read_only" ? "emptyReadAttempts" : "emptyAttempts")) +
    (historical.length ? '<details class="history"><summary>' + text("attemptHistory", { count: historical.length }) + "</summary>" + historical.slice(0, 10).map(renderAttempt).join("") + "</details>" : "");
  $("#gates").innerHTML = (waiting.length ? waiting.map((gate) => renderGate(gate, true)).join("") : empty("emptyGatesTitle", "emptyGates")) +
    (historicalGates.length ? '<details class="history"><summary>' + text("history", { count: historicalGates.length }) + "</summary>" + historicalGates.slice(0, 10).map((gate) => renderGate(gate, false)).join("") + "</details>" : "");
  $("#nodes").innerHTML = nodes.length ? nodes.map((node) => {
    const attempt = attempts.find((item) => item.attempt_id === node.enrollment_attempt_id);
    const synthetic = attempt?.evidence?.some((item) => typeof item.source === "string" && item.source.startsWith("synthetic"));
    return '<tr><td><strong>' + h(node.node_id) + '</strong><div class="record-id">' + h(node.node_uid) +
      "</div>" + (synthetic ? '<span class="simulation">' + text("simulation") + "</span>" : "") +
      "</td><td>" + h(node.platform) + "</td><td>" + badge(node.lifecycle) + '</td><td title="' + h(node.admitted_at) + '">' + h(date(node.admitted_at)) + "</td></tr>";
  }).join("") : '<tr><td colspan="4">' + empty("emptyNodesTitle", "emptyNodes") + "</td></tr>";
  $("#capabilities").innerHTML = capabilities.length ? capabilities.map((capability) =>
    '<div class="list-row"><strong>' + h(capability.id) + '</strong><span class="secondary">' +
    text("risk" + capability.risk) + " · " + h(capability.description) + "</span></div>").join("") : empty("emptyCapsTitle", "emptyCaps");
  const subjectName = (subject) => attempts.find((item) => item.attempt_id === subject)?.asset_hint ||
    nodes.find((item) => item.node_uid === subject)?.node_id ||
    attempts.find((item) => item.attempt_id === gates.find((gate) => gate.gate_id === subject)?.subject_id)?.asset_hint || subject;
  $("#events").innerHTML = events.length ? events.slice(-20).reverse().map((event) =>
    '<div class="list-row"><strong title="' + h(event.type) + '">' + text("event." + event.type) +
    '</strong><span class="secondary">' + h(subjectName(event.subject)) +
    (event.data?.to ? " · " + text("state." + event.data.to) : "") +
    '</span><time class="activity-time" datetime="' + h(event.at) + '" title="' + h(event.at) + '">' + h(date(event.at)) + "</time></div>").join("") : empty("emptyEventsTitle", "emptyEvents");
}

function render() {
  $("#connection-status").className = "connection-status" + (snapshot ? " is-connected" : "");
  $("#connection-status").innerHTML = '<span class="status-dot" aria-hidden="true"></span>' + text(snapshot ? access === "operator" ? "operator" : "readOnly" : "disconnected");
  $("#refresh").disabled = !snapshot || busy;
  $("#refresh").textContent = t(busy && snapshot ? "refreshing" : "refresh");
  $("#connect button[type=submit]").disabled = busy;
  $("#connect button[type=submit]").textContent = t(busy && !snapshot ? "connecting" : "connect");
  $("#api-token").disabled = busy;
  $("#disconnect").disabled = !accessToken;
  $("#asset-hint").disabled = !writable();
  $("#new-attempt button").disabled = !writable();
  $("#permission-note").textContent = t(uncertain ? "permissionUncertain" : !snapshot ? "permissionDisconnected" : access === "read_only" ? "permissionReadOnly" : "permissionOperator");
  $(".workspace-grid").setAttribute("aria-busy", String(busy));
  renderData();
  renderFeedback();
}

function clearSession() {
  epoch += 1;
  session.abort();
  session = new AbortController();
  accessToken = "";
  access = null;
  snapshot = null;
  busy = false;
  uncertain = false;
  $("#api-token").value = "";
  $("#new-attempt").reset();
  $("#connection-panel").open = true;
}

function errorKey(error, connecting = false) {
  if (error.message === "UNAUTHORIZED") return "errorUnauthorized";
  if (error.message === "AUTH_NOT_CONFIGURED") return "errorConfig";
  if (error.message === "READ_ONLY_CREDENTIAL") return "errorReadOnly";
  if (error.message.includes("EXPIRED")) return "errorExpired";
  if (error.message === "ACCEPTANCE_EVIDENCE_MISSING") return "errorEvidence";
  if (error.message.includes("STATE") || error.message.includes("RESOLVED") || error.message.includes("TRANSITION") || error.message === "HUMAN_GATE_APPROVAL_REQUIRED") return "errorConflict";
  if (error.message === "NETWORK_ERROR") return connecting ? "errorConnectNetwork" : "errorNetwork";
  return "errorRequest";
}

async function task(action, { mutation = false, success = "updatedNotice", connecting = false } = {}) {
  if (busy) return;
  const ownEpoch = epoch;
  const focusedAttempt = document.activeElement?.dataset.attempt || snapshot?.gates.find((gate) => gate.gate_id === document.activeElement?.dataset.gate)?.subject_id;
  busy = true;
  feedback = null;
  render();
  let changed = false;
  try {
    if (action) { await action(); changed = mutation; }
    const next = await readSnapshot();
    if (ownEpoch !== epoch) return;
    snapshot = next;
    access = next.access;
    uncertain = false;
    $("#connection-panel").open = false;
    showFeedback(success, "success");
  } catch (error) {
    if (ownEpoch !== epoch) return;
    const key = mutation && (changed || error.ambiguous) ? "errorAmbiguous" : errorKey(error, connecting);
    if (error.message === "UNAUTHORIZED" || connecting) clearSession();
    else if (mutation && (changed || error.ambiguous)) uncertain = true;
    showFeedback(key, "error");
  } finally {
    if (ownEpoch === epoch) {
      busy = false;
      render();
      if (focusedAttempt && document.activeElement === document.body) {
        const record = $('[data-record-id="' + CSS.escape(focusedAttempt) + '"]');
        const target = record?.querySelector("button:not(:disabled)") || record;
        if (target?.getClientRects().length) target.focus({ preventScroll: true });
      }
    }
    else if (!accessToken) render();
  }
}

$("#connect").addEventListener("submit", (event) => {
  event.preventDefault();
  if (busy) return;
  const token = $("#api-token").value.trim();
  clearSession();
  accessToken = token;
  task(null, { connecting: true, success: "connectedNotice" });
});
$("#disconnect").addEventListener("click", () => {
  clearSession();
  showFeedback("disconnectedNotice");
  render();
  $("#api-token").focus();
});
$("#refresh").addEventListener("click", () => task(null, { success: "refreshedNotice" }));
$("#new-attempt").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!writable()) return;
  const asset_hint = $("#asset-hint").value.trim();
  if (!asset_hint) { $("#asset-hint").focus(); return; }
  task(async () => {
    await post("/v0/enrollment-attempts", { asset_hint });
    $("#new-attempt").reset();
  }, { mutation: true, success: "createdNotice" });
});
document.addEventListener("click", (event) => {
  if (!writable()) return;
  const attemptButton = event.target.closest("[data-attempt]");
  const gateButton = event.target.closest("[data-gate]");
  if (attemptButton) {
    const { attempt: id, action } = attemptButton.dataset;
    const attempt = snapshot.attempts.find((item) => item.attempt_id === id);
    if (!attempt || expired(attempt)) { showFeedback("errorExpired", "error"); render(); return; }
    task(() => post("/v0/enrollment-attempts/" + encodeURIComponent(id) + "/" + action), { mutation: true });
  } else if (gateButton) {
    const { gate: id, decision } = gateButton.dataset;
    const gate = snapshot.gates.find((item) => item.gate_id === id);
    if (!gate || !gateActionable(gate)) { showFeedback("errorConflict", "error"); render(); return; }
    task(() => post("/v0/human-gates/" + encodeURIComponent(id) + "/resolve", { decision }), { mutation: true });
  }
});
$("#language").addEventListener("change", (event) => { setLanguage(event.target.value); render(); });
applyLocale();
render();
