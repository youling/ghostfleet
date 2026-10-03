import { publicClone } from "../core/security.js";

function blankState() {
  return { attempts: {}, gates: {}, nodes: {}, events: [], capability_definitions: {} };
}

export class InMemoryStore {
  constructor(snapshot = null) { this.state = snapshot ? structuredClone(snapshot) : blankState(); }
  snapshot() { return publicClone(this.state); }
  getAttempt(id) { return Object.hasOwn(this.state.attempts, id) ? publicClone(this.state.attempts[id]) : null; }
  putAttempt(value) { this.state.attempts[value.attempt_id] = publicClone(value); return this.getAttempt(value.attempt_id); }
  listAttempts() { return Object.values(this.state.attempts).map(publicClone); }
  getGate(id) { return Object.hasOwn(this.state.gates, id) ? publicClone(this.state.gates[id]) : null; }
  putGate(value) { this.state.gates[value.gate_id] = publicClone(value); return this.getGate(value.gate_id); }
  listGates() { return Object.values(this.state.gates).map(publicClone); }
  getNode(id) { return Object.hasOwn(this.state.nodes, id) ? publicClone(this.state.nodes[id]) : null; }
  putNode(value) { this.state.nodes[value.node_uid] = publicClone(value); return this.getNode(value.node_uid); }
  listNodes() { return Object.values(this.state.nodes).map(publicClone); }
  appendEvent(value) { this.state.events.push(publicClone(value)); return publicClone(value); }
  listEvents() { return this.state.events.map(publicClone); }
  getCapabilityDefinition(id) { return Object.hasOwn(this.state.capability_definitions, id) ? publicClone(this.state.capability_definitions[id]) : null; }
  putCapabilityDefinition(value) { this.state.capability_definitions[value.id] = publicClone(value); return this.getCapabilityDefinition(value.id); }
  listCapabilityDefinitions() { return Object.values(this.state.capability_definitions).map(publicClone); }
}
