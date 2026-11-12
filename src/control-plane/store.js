import { publicClone } from "../core/security.js";
import { normalizeAgentState, projectNode } from "./node-agent.js";

// Durable events are kept as a bounded ring: the blob store has no CAS (§10),
// so unbounded growth on one hot path would eventually fail every write.
export const DEFAULT_EVENTS_LIMIT = 200;

function blankState() {
  return { attempts: {}, gates: {}, nodes: {}, events: [], capability_definitions: {}, consumer_acceptances: {} };
}

export class InMemoryStore {
  constructor(snapshot = null, options = {}) {
    this.state = snapshot ? structuredClone(snapshot) : blankState();
    const limit = Number.isInteger(options.events_limit) ? options.events_limit : DEFAULT_EVENTS_LIMIT;
    this.events_limit = Math.max(0, limit);
    // Monotonic counter of durable mutations. The blob store has no CAS (§10),
    // so the adapter uses this to rewrite the single blob only when a request
    // actually changed state instead of on every non-GET response.
    this.writes = 0;
  }
  /** Internal durable state. Unlike the public accessors this keeps raw records. */
  snapshot() { return structuredClone(this.state); }
  getAttempt(id) { return Object.hasOwn(this.state.attempts, id) ? publicClone(this.state.attempts[id]) : null; }
  putAttempt(value) { this.state.attempts[value.attempt_id] = publicClone(value); this.writes += 1; return this.getAttempt(value.attempt_id); }
  listAttempts() { return Object.values(this.state.attempts).map(publicClone); }
  getGate(id) { return Object.hasOwn(this.state.gates, id) ? publicClone(this.state.gates[id]) : null; }
  putGate(value) { this.state.gates[value.gate_id] = publicClone(value); this.writes += 1; return this.getGate(value.gate_id); }
  listGates() { return Object.values(this.state.gates).map(publicClone); }
  /** Raw node record for internal callers that need the agent subtree. */
  getNode(id) { return Object.hasOwn(this.state.nodes, id) ? structuredClone(this.state.nodes[id]) : null; }
  putNode(value) {
    const record = structuredClone(value);
    record.agent = normalizeAgentState(record.agent);
    this.state.nodes[record.node_uid] = record;
    this.writes += 1;
    return projectNode(record);
  }
  putNodeAgent(node_uid, agent) {
    const current = Object.hasOwn(this.state.nodes, node_uid) ? this.state.nodes[node_uid] : null;
    if (!current) return null;
    this.state.nodes[node_uid] = { ...current, agent: normalizeAgentState(agent) };
    this.writes += 1;
    return projectNode(this.state.nodes[node_uid]);
  }
  /** Raw node records, for protocol verification that must not mutate state. */
  rawNodes() { return structuredClone(this.state.nodes); }
  /**
   * Credential digests only, for the cross-node scope check on the
   * unauthenticated path: cloning every node record there would let an anonymous
   * caller amplify one request into a full copy of durable state.
   */
  credentialDigests() {
    return Object.values(this.state.nodes)
      .map((node) => normalizeAgentState(node?.agent).credential_digest)
      .filter((digest) => typeof digest === "string" && digest);
  }
  listNodes() { return Object.values(this.state.nodes).map(projectNode); }
  appendEvent(value) {
    this.state.events.push(publicClone(value));
    const overflow = this.state.events.length - this.events_limit;
    if (overflow > 0) this.state.events.splice(0, overflow);
    this.writes += 1;
    return publicClone(value);
  }
  listEvents() { return this.state.events.map(publicClone); }
  getCapabilityDefinition(id) { return Object.hasOwn(this.state.capability_definitions, id) ? publicClone(this.state.capability_definitions[id]) : null; }
  putCapabilityDefinition(value) { this.state.capability_definitions[value.id] = publicClone(value); this.writes += 1; return this.getCapabilityDefinition(value.id); }
  listCapabilityDefinitions() { return Object.values(this.state.capability_definitions).map(publicClone); }
  getConsumerAcceptance(id) {
    const records = this.state.consumer_acceptances || {};
    return Object.hasOwn(records, id) ? publicClone(records[id]) : null;
  }
  putConsumerAcceptance(value) {
    this.state.consumer_acceptances ||= {};
    this.state.consumer_acceptances[value.acceptance_id] = publicClone(value);
    this.writes += 1;
    return this.getConsumerAcceptance(value.acceptance_id);
  }
  listConsumerAcceptances() { return Object.values(this.state.consumer_acceptances || {}).map(publicClone); }
  getEnrollmentTicket(id) {
    const tickets = this.state.enrollment_tickets || {};
    return Object.hasOwn(tickets, id) ? publicClone(tickets[id]) : null;
  }
  putEnrollmentTicket(value) {
    this.state.enrollment_tickets ||= {};
    this.state.enrollment_tickets[value.ticket_id] = publicClone(value);
    this.writes += 1;
    return this.getEnrollmentTicket(value.ticket_id);
  }
  listEnrollmentTickets() { return Object.values(this.state.enrollment_tickets || {}).map(publicClone); }
  findEnrollmentTicketByAttempt(attempt_id) { return this.listEnrollmentTickets().findLast((ticket) => ticket.attempt_id === attempt_id) || null; }
  findEnrollmentTicketByResumeDigest(resume_capability_digest) { return this.listEnrollmentTickets().find((ticket) => ticket.resume_capability_digest === resume_capability_digest) || null; }
}
