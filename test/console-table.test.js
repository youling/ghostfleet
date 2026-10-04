import test from "node:test";
import assert from "node:assert/strict";
import { enrollmentDisplayName, selectRows } from "../console/table-model.js";

test("structured enrollment hints display only the node bound to that attempt", () => {
  const attempt = { attempt_id: "attempt-1", node_uid: "node-1", asset_hint: { enrollment_ref: "opaque-ref", assets_join: "UNBOUND" } };
  const nodes = [{ node_uid: "node-1", node_id: "Linux device", enrollment_attempt_id: "attempt-1" }];
  const before = structuredClone({ attempt, nodes });
  assert.equal(enrollmentDisplayName(attempt, nodes), "Linux device");
  assert.equal(enrollmentDisplayName(attempt, [{ ...nodes[0], enrollment_attempt_id: "another-attempt" }]), "attempt-1");
  assert.equal(enrollmentDisplayName(attempt, [{ ...nodes[0], node_uid: "another-node" }]), "attempt-1");
  assert.equal(enrollmentDisplayName({ ...attempt, attempt_id: undefined }, nodes, "subject-1"), "subject-1");
  assert.deepEqual({ attempt, nodes }, before);
});
test("pending enrollments retain a string label or a stable ID without coercing arbitrary hints", () => {
  assert.equal(enrollmentDisplayName({ attempt_id: "attempt-1", asset_hint: "Named device" }), "Named device");
  for (const hint of [{}, [], ["device"], 42, true, null, undefined, "", "   "]) {
    assert.equal(enrollmentDisplayName({ attempt_id: "attempt-1", asset_hint: hint }), "attempt-1");
  }
  assert.equal(enrollmentDisplayName(undefined, [], "subject-1"), "subject-1");
});

const adapter = {
  searchText: (row) => row.name + " " + row.id,
  statusOf: (row) => row.status,
  categoryOf: (row) => row.category,
  valueOf: (row, key) => row[key],
};
test("table search, status and category compose without changing the source records", () => {
  const rows = [
    { id: "a", name: "ThinkPad 10", status: "ACTIVE", category: "current" },
    { id: "b", name: "ThinkPad 2", status: "ACTIVE", category: "current" },
    { id: "c", name: "ThinkPad 1", status: "ACTIVE", category: "completed" },
    { id: "d", name: "ThinkPad 3", status: "SUSPENDED", category: "current" },
  ];
  const before = structuredClone(rows);
  const selected = selectRows(rows, { query: " THINKPAD ", status: "ACTIVE", tab: "current", sortKey: "name", direction: "asc", page: 8, pageSize: 10 }, adapter);
  assert.deepEqual(selected.rows.map((row) => row.id), ["b", "a"]);
  assert.equal(selected.page, 1);
  assert.equal(selected.total, 2);
  assert.deepEqual(rows, before);
});
test("pagination recovers from a removed last page and invalid view input", () => {
  const rows = Array.from({ length: 11 }, (_, index) => ({ id: index, name: "record", date: index }));
  const selected = selectRows(rows, { page: 3, pageSize: 10, sortKey: "date", direction: "asc" }, adapter);
  assert.equal(selected.page, 2);
  assert.deepEqual(selected.rows.map((row) => row.id), [10]);
  assert.equal(selected.from, 11);
  assert.equal(selected.to, 11);
  const invalid = selectRows(rows, { page: Infinity, pageSize: 0, sortKey: "date" }, adapter);
  assert.equal(invalid.page, 1);
  assert.equal(invalid.pageSize, 10);
});
test("empty filtered tables have a valid page and an honest zero range", () => {
  const selected = selectRows([{ id: "node-1", name: "ThinkPad" }], { query: "missing", page: 9 }, adapter);
  assert.deepEqual(selected.rows, []);
  assert.equal(selected.page, 1);
  assert.equal(selected.pages, 1);
  assert.equal(selected.from, 0);
  assert.equal(selected.to, 0);
  assert.equal(selected.total, 0);
});
test("missing dates sort after dated records in either direction", () => {
  const rows = [{ id: "unknown", date: null }, { id: "old", date: 1 }, { id: "recent", date: 2 }];
  for (const direction of ["asc", "desc"]) {
    const selected = selectRows(rows, { sortKey: "date", direction }, adapter);
    assert.equal(selected.rows.at(-1).id, "unknown");
    assert.equal(selected.rows[0].id, direction === "asc" ? "old" : "recent");
  }
});
