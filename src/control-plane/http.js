function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

async function body(request) {
  if (!request.body) return {};
  const text = await request.text();
  return text ? JSON.parse(text) : {};
}

function errorResponse(error) {
  const code = error?.code || (error instanceof SyntaxError ? "INVALID_JSON" : error?.message) || "INTERNAL_ERROR";
  const status = Number.isInteger(error?.status) ? error.status : code.includes("NOT_FOUND") ? 404 : code.includes("INVALID") || code.includes("MISSING") ? 409 : 400;
  const payload = { ok: false, error: code };
  if (Array.isArray(error?.missing)) payload.missing = error.missing;
  return json(payload, status);
}

export function createHttpHandler(controller) {
  return async function handle(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (request.method === "GET" && path === "/healthz") return json({ ok: true, service: "ghostfleet", version: "0.1.0-dev" });
      if (request.method === "GET" && path === "/v0/nodes") return json({ ok: true, nodes: controller.listNodes() });
      if (request.method === "GET" && path === "/v0/enrollment-attempts") return json({ ok: true, attempts: controller.listEnrollmentAttempts() });
      if (request.method === "GET" && path === "/v0/enrollment-templates") return json({ ok: true, templates: controller.listEnrollmentTemplates() });
      if (request.method === "GET" && path === "/v0/human-gates") return json({ ok: true, gates: controller.listHumanGates() });
      if (request.method === "GET" && path === "/v0/events") return json({ ok: true, events: controller.listEvents() });
      if (request.method === "GET" && path === "/v0/capabilities") return json({ ok: true, capabilities: controller.listCapabilityDefinitions() });
      if (request.method === "POST" && path === "/v0/capabilities") return json({ ok: true, capability: controller.registerCapabilityDefinition(await body(request)) }, 201);
      if (request.method === "POST" && path === "/v0/enrollment-attempts") return json({ ok: true, attempt: controller.createEnrollmentAttempt(await body(request)) }, 201);

      let match = /^\/v0\/enrollment-attempts\/([^/]+)$/.exec(path);
      if (request.method === "GET" && match) return json({ ok: true, attempt: controller.getEnrollmentAttempt(match[1]) });

      match = /^\/v0\/enrollment-attempts\/([^/]+)\/ticket$/.exec(path);
      if (request.method === "GET" && match) return json({ ok: true, ticket: controller.getEnrollmentTicket(match[1]) });
      if (request.method === "POST" && match) {
        const input = await body(request);
        return json({ ok: true, ...controller.issueEnrollmentTicket(match[1], { ...input, public_origin: url.origin }) }, 201);
      }

      match = /^\/v0\/enrollment-attempts\/([^/]+)\/ticket\/revoke$/.exec(path);
      if (request.method === "POST" && match) return json({ ok: true, ticket: controller.revokeEnrollmentTicket(match[1]) });

      match = /^\/v1\/enrollment-tickets\/([^/]+)\/claim$/.exec(path);
      if (request.method === "POST" && match) {
        const short_code = (await request.text()).trim();
        const preflight_digest = request.headers.get("x-ghostfleet-preflight-digest") || "";
        return json({ ok: true, ...(await controller.claimEnrollmentTicket({ claim_factor: decodeURIComponent(match[1]), short_code, preflight_digest })) });
      }

      if (request.method === "POST" && path === "/v1/enroll/complete") {
        const input = await body(request);
        return json({ ok: true, ...controller.completeEnrollmentTicket(input) });
      }

      match = /^\/v0\/enrollment-attempts\/([^/]+)\/([^/]+)$/.exec(path);
      if (request.method === "POST" && match) {
        const [, id, action] = match;
        const input = await body(request);
        if (action === "prepare") return json({ ok: true, attempt: controller.prepareEnrollmentAttempt(id) });
        if (action === "claim") return json({ ok: true, attempt: controller.claimEnrollmentAttempt(id) });
        if (action === "materialize") return json({ ok: true, attempt: controller.startMaterialization(id, input) });
        if (action === "human-gates") return json({ ok: true, gate: controller.requireEnrollmentHumanGate(id, input) }, 201);
        if (action === "evidence") return json({ ok: true, evidence: controller.recordEvidence(id, input) }, 201);
        if (action === "reconcile-required") return json({ ok: true, attempt: controller.markReconcileRequired(id, input.reason) });
        if (action === "reconcile") return json({ ok: true, attempt: controller.resumeFromReconcile(id, input.resume_state) });
        if (action === "accept") return json({ ok: true, node: controller.acceptEnrollment(id, input) }, 201);
      }

      match = /^\/v0\/human-gates\/([^/]+)\/resolve$/.exec(path);
      if (request.method === "POST" && match) {
        const input = await body(request);
        return json({ ok: true, ...controller.resolveHumanGate(match[1], input.decision) });
      }

      return json({ ok: false, error: "NOT_FOUND" }, 404);
    } catch (error) {
      return errorResponse(error);
    }
  };
}
