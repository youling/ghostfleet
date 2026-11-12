import { NODE_BODY_LIMITS } from "./node-agent.js";

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

// Public, unauthenticated routes share one global control-plane object, so an
// anonymous oversized body must be refused before it is buffered or parsed.
// The claim body is one short code; a completion report has its own controller
// bound (128 KiB); everything else keeps a modest default.
export const BODY_LIMITS = Object.freeze({ default: 1048576, claim: 1024, complete: 262144 });

export class RequestBodyTooLarge extends Error {
  constructor(limit) {
    super("REQUEST_BODY_TOO_LARGE");
    this.name = "RequestBodyTooLarge";
    this.code = "REQUEST_BODY_TOO_LARGE";
    this.status = 413;
    this.limit = limit;
  }
}

async function readText(request, limit) {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) throw new RequestBodyTooLarge(limit);
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new RequestBodyTooLarge(limit);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function body(request, limit = BODY_LIMITS.default) {
  const text = await readText(request, limit);
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
  // A node request is bounded, verified, and only then applied. The body limit
  // is enforced twice (declared content-length and streamed byte count) because
  // an anonymous node token holder is not trusted with the buffer.
  async function nodeAgentRequest(request, node_uid, kind, task_id = null) {
    const limit = NODE_BODY_LIMITS[kind];
    const text = await readText(request, limit);
    const verification = controller.verifyNodeRequest({ node_uid, headers: request.headers, body: text, limit });
    if (!verification.ok) return json({ ok: false, error: verification.code }, verification.status);
    if (kind === "heartbeat") return json(controller.nodeHeartbeat(verification));
    if (kind === "poll") return json(controller.pollNodeTasks(verification));
    return json(controller.applyNodeTaskResult(verification, task_id));
  }

  return async function handle(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (request.method === "GET" && path === "/healthz") return json({ ok: true, service: "ghostfleet", version: "0.1.0-dev" });
      if (request.method === "GET" && path === "/v0/nodes") return json({ ok: true, nodes: controller.listNodes() });

      // Node agent plane (§5.2). These three routes authenticate with the node
      // credential, never the operator bearer, so they are matched before the
      // operator route table and verify before touching any state.
      const heartbeatRoute = /^\/v0\/nodes\/([^/]+)\/heartbeat$/.exec(path);
      if (request.method === "POST" && heartbeatRoute) return await nodeAgentRequest(request, decodeURIComponent(heartbeatRoute[1]), "heartbeat");
      const pollRoute = /^\/v0\/nodes\/([^/]+)\/tasks\/poll$/.exec(path);
      if (request.method === "POST" && pollRoute) return await nodeAgentRequest(request, decodeURIComponent(pollRoute[1]), "poll");
      const resultRoute = /^\/v0\/nodes\/([^/]+)\/tasks\/([^/]+)\/result$/.exec(path);
      if (request.method === "POST" && resultRoute) {
        return await nodeAgentRequest(request, decodeURIComponent(resultRoute[1]), "result", decodeURIComponent(resultRoute[2]));
      }
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
        const input = await body(request, BODY_LIMITS.default);
        // The delivery coordinates are deployment configuration; the request
        // origin is never used as a fallback.
        return json({ ok: true, ...(await controller.issueEnrollmentTicket(match[1], input)) }, 201);
      }

      match = /^\/v0\/enrollment-attempts\/([^/]+)\/ticket\/revoke$/.exec(path);
      if (request.method === "POST" && match) return json({ ok: true, ticket: controller.revokeEnrollmentTicket(match[1]) });

      match = /^\/v1\/enrollment-tickets\/([^/]+)\/claim$/.exec(path);
      if (request.method === "POST" && match) {
        const short_code = (await readText(request, BODY_LIMITS.claim)).trim();
        const preflight_digest = request.headers.get("x-ghostfleet-preflight-digest") || "";
        return json({ ok: true, ...(await controller.claimEnrollmentTicket({ ticket_id: decodeURIComponent(match[1]), short_code, preflight_digest })) });
      }

      if (request.method === "POST" && path === "/v1/enroll/complete") {
        const input = await body(request, BODY_LIMITS.complete);
        return json({ ok: true, ...controller.completeEnrollmentTicket(input) });
      }

      match = /^\/v0\/enrollment-attempts\/([^/]+)\/([^/]+)$/.exec(path);
      if (request.method === "POST" && match) {
        const [, id, action] = match;
        // Public Operator authentication is not proof of the Linux target's
        // transport, installation, control canary, zero-delta or recovery.
        // The old operator-writable evidence route could fabricate PASS and
        // then call /accept. Trusted observers must instead enter through
        // a separately authenticated server integration, never this route.
        if (action === "evidence") {
          return json({ ok: false, error: "EVIDENCE_TRUSTED_INGRESS_REQUIRED" }, 403);
        }
        const input = await body(request);
        if (action === "prepare") return json({ ok: true, attempt: controller.prepareEnrollmentAttempt(id) });
        if (action === "claim") return json({ ok: true, attempt: controller.claimEnrollmentAttempt(id) });
        if (action === "materialize") return json({ ok: true, attempt: controller.startMaterialization(id, input) });
        if (action === "human-gates") return json({ ok: true, gate: controller.requireEnrollmentHumanGate(id, input) }, 201);
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
