function escapeHtml(value) {
  const node = document.createElement("div");
  node.textContent = String(value ?? "");
  return node.innerHTML;
}

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || "REQUEST_FAILED");
  return data;
}

async function post(path, payload = {}) {
  return api(path, { method: "POST", body: JSON.stringify(payload) });
}

function attemptActions(attempt) {
  const id = escapeHtml(attempt.attempt_id);
  if (attempt.state === "CREATED") return `<button class="btn btn-sm btn-outline-primary" data-attempt="${id}" data-action="prepare">Prepare</button>`;
  if (attempt.state === "PREPARING") return `<div class="btn-list"><button class="btn btn-sm btn-outline-primary" data-attempt="${id}" data-action="human-gates">Require Human Gate</button><button class="btn btn-sm btn-outline-secondary" data-attempt="${id}" data-action="claim">Claim</button></div>`;
  if (attempt.state === "CLAIMED") return `<button class="btn btn-sm btn-outline-primary" data-attempt="${id}" data-action="materialize">Materialize</button>`;
  return "";
}

async function runAttemptAction(id, action) {
  await post(`/v0/enrollment-attempts/${encodeURIComponent(id)}/${action}`);
  await refresh();
}

async function resolveGate(id, decision) {
  await post(`/v0/human-gates/${encodeURIComponent(id)}/resolve`, { decision });
  await refresh();
}

async function refresh() {
  const [attemptsData, gatesData, nodesData, eventsData, capsData] = await Promise.all([
    api("/v0/enrollment-attempts"),
    api("/v0/human-gates"),
    api("/v0/nodes"),
    api("/v0/events"),
    api("/v0/capabilities"),
  ]);

  const attempts = attemptsData.attempts;
  const gates = gatesData.gates;
  const nodes = nodesData.nodes;
  const events = eventsData.events;
  const capabilities = capsData.capabilities;
  const waiting = gates.filter((gate) => gate.state === "WAITING").length;

  document.querySelector("#summary").innerHTML = [
    ["Nodes", nodes.length],
    ["Enrollment attempts", attempts.length],
    ["Waiting Human Gates", waiting],
  ].map(([label, value]) => `<div class="col-sm-4"><div class="card card-sm"><div class="card-body"><div class="font-weight-medium">${escapeHtml(value)}</div><div class="text-secondary">${escapeHtml(label)}</div></div></div></div>`).join("");

  document.querySelector("#attempts").innerHTML = attempts.length
    ? attempts.map((attempt) => `<div class="border rounded p-3 mb-2"><div class="d-flex justify-content-between gap-2"><div><div class="fw-bold">${escapeHtml(attempt.asset_hint || attempt.attempt_id)}</div><div class="text-secondary small">${escapeHtml(attempt.state)} · rev ${escapeHtml(attempt.revision)}</div></div><div>${attemptActions(attempt)}</div></div></div>`).join("")
    : `<div class="text-secondary">No enrollment attempts.</div>`;

  document.querySelector("#gates").innerHTML = gates.length
    ? gates.map((gate) => {
        const controls = gate.state === "WAITING"
          ? `<div class="btn-list"><button class="btn btn-sm btn-success" data-gate="${escapeHtml(gate.gate_id)}" data-decision="APPROVE">Approve</button><button class="btn btn-sm btn-outline-danger" data-gate="${escapeHtml(gate.gate_id)}" data-decision="REJECT">Reject</button></div>`
          : "";
        return `<div class="border rounded p-3 mb-2"><div class="fw-bold">${escapeHtml(gate.gate_type)}</div><div class="text-secondary small mb-2">${escapeHtml(gate.state)} · ${escapeHtml(gate.subject_id)}</div>${controls}</div>`;
      }).join("")
    : `<div class="text-secondary">No Human Gates.</div>`;

  document.querySelector("#nodes").innerHTML = nodes.map((node) => `<tr><td><strong>${escapeHtml(node.node_id)}</strong><div class="text-secondary small">${escapeHtml(node.node_uid)}</div></td><td>${escapeHtml(node.platform)}</td><td><span class="badge bg-green-lt">${escapeHtml(node.lifecycle)}</span></td><td>${escapeHtml(node.admitted_at)}</td></tr>`).join("");

  document.querySelector("#capabilities").innerHTML = capabilities.length
    ? capabilities.map((capability) => `<div class="mb-2"><span class="badge bg-azure-lt me-2">${escapeHtml(capability.risk)}</span><strong>${escapeHtml(capability.id)}</strong><div class="text-secondary small">${escapeHtml(capability.description)}</div></div>`).join("")
    : `<div class="text-secondary">No adapter capabilities registered yet.</div>`;

  document.querySelector("#events").innerHTML = events.slice(-20).reverse().map((event) => `<div class="mb-2"><strong>${escapeHtml(event.type)}</strong><div class="text-secondary small">${escapeHtml(event.subject)} · ${escapeHtml(event.at)}</div></div>`).join("");
}

document.addEventListener("click", async (event) => {
  const attemptButton = event.target.closest("[data-attempt]");
  if (attemptButton) {
    try { await runAttemptAction(attemptButton.dataset.attempt, attemptButton.dataset.action); }
    catch (error) { window.alert(error.message); }
  }
  const gateButton = event.target.closest("[data-gate]");
  if (gateButton) {
    try { await resolveGate(gateButton.dataset.gate, gateButton.dataset.decision); }
    catch (error) { window.alert(error.message); }
  }
});

document.querySelector("#new-attempt").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await post("/v0/enrollment-attempts", { asset_hint: form.get("asset_hint") || null });
    event.currentTarget.reset();
    await refresh();
  } catch (error) { window.alert(error.message); }
});

refresh().catch((error) => {
  document.querySelector("#attempts").innerHTML = `<div class="alert alert-danger">${escapeHtml(error.message)}</div>`;
});
