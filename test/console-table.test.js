import test from "node:test";
import assert from "node:assert/strict";
import { selectRows } from "../console/table-model.js";

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
