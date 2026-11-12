import { NODE_BODY_LIMITS, NodeAgentError } from "./node-agent.js";

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

// Public, unauthenticated routes share one global control-plane object, so an
// anonymous oversized body must be refused before it is buffered or parsed.
// The claim body is one short code; a completion report has its own controller
// bound (128 KiB); everything else keeps a modest default.
export const BODY_LIMITS = Object.freeze({
  default: 1048576, claim: 1024, complete: 262144, node_task: 4096, node_credential: 1024,
});

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

// A response that carries a plaintext node credential must never be stored by an
// intermediary cache, including a retried completion or a rotation.
const CREDENTIAL_RESPONSE_HEADERS = Object.freeze({ "cache-control": "no-store", pragma: "no-cache" });

// Only a contract-shaped code is reflected to the caller. An internal message
// ("Cannot read properties of undefined ...", "Maximum call stack size exceeded")
// is a bug, not a protocol answer, so it is logged and answered as a generic 500.
const CONTRACT_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,79}$/;

// A path segment that is not valid percent-encoding is not an identifier. It is
// decoded before any authentication runs, so a URIError must never surface as a
// 500 with a stack: the route simply does not exist. Every captured segment goes
// through this one decoder.
function decodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

const flatNotFound = () => json({ ok: false, error: "NOT_FOUND" }, 404);

function errorResponse(error) {
  const candidate =
    (typeof error?.code === "string" && error.code) ||
    (error instanceof SyntaxError ? "INVALID_JSON" : typeof error?.message === "string" ? error.message : "");
  if (!CONTRACT_CODE_PATTERN.test(candidate)) {
    console.error("control-plane internal error:", error);
    return json({ ok: false, error: "INTERNAL_ERROR" }, 500);
  }
  const code = candidate;
  // The operator edge answers a request-shape problem with 400. Only a code that
  // carries an explicit status (NodeAgentError, EnrollmentTicketError, the body
  // cap, an auth denial) or a lookup that found nothing keeps another status.
  // Mapping every "*_INVALID" to 409 told an operator client to re-read state
  // instead of fixing the request, and made malformed JSON look like a conflict.
  const status = Number.isInteger(error?.status) ? error.status : code.includes("NOT_FOUND") ? 404 : 400;
  // The operator plane follows the same double-field convention as the node
  // plane: `error` is this repo's convention and `code` is what a client that
  // dispatches on a stable code reads (na-core client.py _extract_error_code).
  const payload = { ok: false, error: code, code };
  if (Array.isArray(error?.missing)) payload.missing = error.missing;
  return json(payload, status);
}

export function createHttpHandler(controller, options = {}) {
  const authorizeOperator = options.authorizeOperator;
  // A node request is bounded, verified, and only then applied. The body limit
  // is enforced twice (declared content-length and streamed byte count) because
  // an anonymous node token holder is not trusted with the buffer.
  // Node-plane failures carry the stable code twice: `error` is this repo's
  // convention, `code` is what the Python agent client dispatches on
  // (na-core client.py _extract_error_code reads `code` or `error.code`).
  // Without the second field a 409 nonce/seq/boot conflict degrades from an
  // automatic retry into a dropped request, so both are always emitted.
  function nodeErrorPayload(code, extra = {}) {
    return { ok: false, error: code, code, ...extra };
  }

  async function nodeAgentRequest(request, node_uid, kind, task_id = null) {
    const limit = NODE_BODY_LIMITS[kind];
    let text;
    try {
      text = await readText(request, limit);
    } catch (error) {
      // One body-cap failure has one code, no matter which layer noticed it.
      if (error instanceof RequestBodyTooLarge) return json(nodeErrorPayload("NODE_BODY_TOO_LARGE"), 413);
      throw error;
    }
    const verification = controller.verifyNodeRequest({ node_uid, headers: request.headers, body: text, limit });
    if (!verification.ok) {
      const payload = nodeErrorPayload(verification.code);
      const headers = {};
      if (Number.isInteger(verification.retry_after_s)) {
        payload.retry_after_s = verification.retry_after_s;
        headers["retry-after"] = String(verification.retry_after_s);
      }
      return json(payload, verification.status, headers);
    }
    try {
      if (kind === "heartbeat") return json(controller.nodeHeartbeat(verification));
      if (kind === "poll") return json(controller.pollNodeTasks(verification));
      return json(controller.applyNodeTaskResult(verification, task_id));
    } catch (error) {
      // Task-level failures (conflict / not found / scope) keep the same shape
      // so a result submission can be classified as terminal by the agent.
      if (error instanceof NodeAgentError) return json(nodeErrorPayload(error.code), error.status);
      throw error;
    }
  }

  // Fail closed by construction: without an explicit operator authorizer no
  // operator route is served at all, so importing this handler directly can never
  // be an authorization bypass. The adapter still gates first; this is the second
  // line, and a node credential is never an operator credential.
  async function requireOperator(request) {
    if (typeof authorizeOperator !== "function") {
      return json({ ok: false, error: "OPERATOR_AUTHORIZATION_UNAVAILABLE" }, 503);
    }
    let outcome;
    try {
      outcome = await authorizeOperator(request);
    } catch {
      return json({ ok: false, error: "OPERATOR_AUTH_INVALID" }, 401);
    }
    // Allowed: `true`, or `null` which is how the reference adapter's
    // authorizeApi reports success. A denial Response passes through unchanged;
    // anything else (including `undefined`) fails closed.
    if (outcome === true || outcome === null) return null;
    if (outcome instanceof Response) return outcome;
    return json({ ok: false, error: "OPERATOR_AUTH_REQUIRED" }, 401);
  }

  return async function handle(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (request.method === "GET" && path === "/healthz") return json({ ok: true, service: "ghostfleet", version: "0.1.0-dev" });

      // Node agent plane (§5.2). These three routes authenticate with the node
      // credential, never the operator bearer, so they are matched before the
      // operator route table and verify before touching any state.
      const heartbeatRoute = /^\/v0\/nodes\/([^/]+)\/heartbeat$/.exec(path);
      if (request.method === "POST" && heartbeatRoute) {
        const node_uid = decodeSegment(heartbeatRoute[1]);
        if (node_uid === null) return flatNotFound();
        return await nodeAgentRequest(request, node_uid, "heartbeat");
      }
      const pollRoute = /^\/v0\/nodes\/([^/]+)\/tasks\/poll$/.exec(path);
      if (request.method === "POST" && pollRoute) {
        const node_uid = decodeSegment(pollRoute[1]);
        if (node_uid === null) return flatNotFound();
        return await nodeAgentRequest(request, node_uid, "poll");
      }
      const resultRoute = /^\/v0\/nodes\/([^/]+)\/tasks\/([^/]+)\/result$/.exec(path);
      if (request.method === "POST" && resultRoute) {
        const node_uid = decodeSegment(resultRoute[1]);
        const task_id = decodeSegment(resultRoute[2]);
        if (node_uid === null || task_id === null) return flatNotFound();
        return await nodeAgentRequest(request, node_uid, "result", task_id);
      }

      // Every remaining /v0 route is an operator action.
      if (path === "/v0" || path.startsWith("/v0/")) {
        const denial = await requireOperator(request);
        if (denial) return denial;
      }
      if (request.method === "GET" && path === "/v0/nodes") return json({ ok: true, nodes: controller.listNodes() });

      // Operator task and credential routes. They reuse the global operator
      // bearer enforced by the adapter, and they never expose a node token.
      if (request.method === "POST" && path === "/v0/node-tasks") {
        const input = await body(request, BODY_LIMITS.node_task);
        for (const key of Object.keys(input ?? {})) {
          if (key !== "node_uid" && key !== "operation" && key !== "params" && key !== "ttl_seconds") {
            // ADR §5.2 pins an unknown operator input key to the task vocabulary;
            // NODE_REQUEST_INVALID belongs to the node-agent request body only.
            throw new NodeAgentError("TASK_REQUEST_INVALID", 400);
          }
        }
        const node_uid = input?.node_uid;
        if (typeof node_uid !== "string") throw new NodeAgentError("TASK_REQUEST_INVALID", 400);
        const task = controller.createNodeTask(node_uid, {
          operation: input.operation, params: input.params, ttl_seconds: input.ttl_seconds,
        });
        return json({
          ok: true, node_uid: task.node_uid, task_id: task.task_id, operation: task.operation,
          issued_at: task.issued_at, expires_at: task.expires_at,
        }, 201);
      }
      if (request.method === "GET" && path === "/v0/node-tasks") {
        const node_uid = url.searchParams.get("node_uid");
        if (typeof node_uid !== "string" || node_uid.length === 0) throw new NodeAgentError("TASK_REQUEST_INVALID", 400);
        return json({ ok: true, node_uid, tasks: controller.listNodeTaskSummaries(node_uid) });
      }
      if (request.method === "POST" && path === "/v0/node-credential/rotate") {
        const input = await body(request, BODY_LIMITS.node_credential);
        const node_uid = input?.node_uid;
        if (typeof node_uid !== "string") throw new NodeAgentError("TASK_REQUEST_INVALID", 400);
        return json(controller.rotateNodeCredential(node_uid), 200, CREDENTIAL_RESPONSE_HEADERS);
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
        const ticket_id = decodeSegment(match[1]);
        if (ticket_id === null) return flatNotFound();
        return json({ ok: true, ...(await controller.claimEnrollmentTicket({ ticket_id, short_code, preflight_digest })) });
      }

      if (request.method === "POST" && path === "/v1/enroll/complete") {
        const input = await body(request, BODY_LIMITS.complete);
        return json({ ok: true, ...controller.completeEnrollmentTicket(input) }, 200, CREDENTIAL_RESPONSE_HEADERS);
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
