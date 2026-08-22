import assert from "node:assert/strict";
import test from "node:test";
import { registerQueryTools } from "./query.js";
import { harness, rows, textOf } from "./harness.js";

const READ = { read: rows([{ id: 1, name: "Анна" }]) };

test("registers the two read tools with read-only annotations", () => {
  const { configs } = harness(registerQueryTools, READ);
  assert.deepEqual(Object.keys(configs).sort(), ["explain", "query"]);
  for (const config of Object.values(configs)) {
    assert.equal(config.annotations?.readOnlyHint, true);
    assert.equal(config.annotations?.destructiveHint, false);
  }
});

test("query runs a read and returns its rows", async () => {
  const { tools, calls } = harness(registerQueryTools, READ);
  const result = await tools.query!({ sql: "SELECT id, name FROM users WHERE id = ?", params: [1] });

  assert.notEqual(result.isError, true);
  assert.equal(calls[0]?.method, "read");
  assert.deepEqual(calls[0]?.params[1], [1]);
  assert.match(textOf(result), /Анна/);
});

test("query refuses a write before it ever reaches the database", async () => {
  const { tools, calls } = harness(registerQueryTools, READ);

  for (const sql of ["DELETE FROM users WHERE id = 1", "UPDATE users SET name = 'x'", "DROP TABLE users"]) {
    const result = await tools.query!({ sql });
    assert.equal(result.isError, true, sql);
    // The refusal must cost nothing: no connection, no statement.
    assert.equal(calls.length, 0, `${sql} must not reach the client`);
  }
  // And it points at the tool that would run it.
  assert.match(textOf(await tools.query!({ sql: "DELETE FROM users WHERE id = 1" })), /execute/);
});

test("query runs the normalized statement, not the raw string", async () => {
  const { tools, calls } = harness(registerQueryTools, READ);
  await tools.query!({ sql: "SELECT 1 -- a comment\n;" });
  const sent = String(calls[0]?.params[0]);
  assert.equal(sent.includes("--"), false, "what runs must be what was checked");
  assert.equal(sent.endsWith(";"), false);
});

test("a truncated result says so in words, not only in a flag", async () => {
  const { tools } = harness(registerQueryTools, { read: rows([{ id: 1 }], { truncated: true }) });
  const text = textOf(await tools.query!({ sql: "SELECT * FROM big_table" }));
  assert.match(text, /"truncated":true/);
  assert.match(text, /Показаны не все строки/);
});

test("the per-call limit is passed through to the client", async () => {
  const { tools, calls } = harness(registerQueryTools, READ);
  await tools.query!({ sql: "SELECT 1", limit: 5 });
  assert.deepEqual(calls[0]?.params[2], { maxRows: 5 });
});

test("explain prefixes the statement and honours the format", async () => {
  const { tools, calls } = harness(registerQueryTools, READ);

  await tools.explain!({ sql: "SELECT 1" });
  assert.match(String(calls[0]?.params[0]), /^EXPLAIN SELECT 1/);

  await tools.explain!({ sql: "SELECT 1", format: "json" });
  assert.match(String(calls[1]?.params[0]), /^EXPLAIN FORMAT=JSON SELECT 1/);

  await tools.explain!({ sql: "SELECT 1", format: "traditional" });
  assert.match(String(calls[2]?.params[0]), /^EXPLAIN SELECT 1/);

  // ANALYZE picks its own format, so it never combines with FORMAT=.
  await tools.explain!({ sql: "SELECT 1", format: "json", analyze: true });
  const analyzed = String(calls[3]?.params[0]);
  assert.match(analyzed, /^EXPLAIN ANALYZE SELECT 1/);
  assert.equal(analyzed.includes("FORMAT="), false);
});

test("explain refuses to plan a write", async () => {
  const { tools, calls } = harness(registerQueryTools, READ);
  // EXPLAIN ANALYZE would actually run it.
  const result = await tools.explain!({ sql: "DELETE FROM users WHERE id = 1", analyze: true });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
});

test("a database failure comes back as a tool error, not a crash", async () => {
  const { tools } = harness(registerQueryTools, READ, [], { throwOn: "read", error: new Error("соединение потеряно") });
  const result = await tools.query!({ sql: "SELECT 1" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /соединение потеряно/);
});
