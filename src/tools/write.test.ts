import assert from "node:assert/strict";
import test from "node:test";
import { registerWriteTools } from "./write.js";
import { harness, textOf } from "./harness.js";
import type { Permissions } from "../types.js";

const NOTHING: Permissions = { insert: false, update: false, delete: false };
const EVERYTHING: Permissions = { insert: true, update: true, delete: true };
const WRITE_RESULT = { write: { affectedRows: 1, changedRows: 1, durationMs: 2 } };

test("the write tool exists even in a read-only install", () => {
  // A missing tool reads as a missing capability, and the model invents
  // workarounds instead of relaying the refusal.
  const { configs } = harness(registerWriteTools, WRITE_RESULT, [NOTHING]);
  assert.ok(configs.execute);
  assert.match(configs.execute?.description ?? "", /только чтение/);
  assert.equal(configs.execute?.annotations?.destructiveHint, true);
  assert.equal(configs.execute?.annotations?.readOnlyHint, false);
  assert.equal(configs.execute?.annotations?.idempotentHint, false);
});

test("the description states the permissions of this particular install", () => {
  const { configs } = harness(registerWriteTools, WRITE_RESULT, [{ insert: true, update: true, delete: false }]);
  assert.match(configs.execute?.description ?? "", /INSERT, UPDATE/);
});

test("a write without its flag is refused before touching the database", async () => {
  const { tools, calls } = harness(registerWriteTools, WRITE_RESULT, [NOTHING]);
  const result = await tools.execute!({ sql: "INSERT INTO t (a) VALUES (1)" });

  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
  assert.match(textOf(result), /ALLOW_INSERT_OPERATION=true/);
  // The permission cannot be granted from the chat, and the message says so.
  assert.match(textOf(result), /перезапуск/);
});

test("a permitted write runs and reports affected rows", async () => {
  const { tools, calls } = harness(registerWriteTools, WRITE_RESULT, [EVERYTHING]);
  const result = await tools.execute!({ sql: "INSERT INTO t (a) VALUES (?)", params: [7] });

  assert.notEqual(result.isError, true);
  assert.equal(calls[0]?.method, "write");
  assert.deepEqual(calls[0]?.params[1], [7]);
  assert.match(textOf(result), /"affectedRows":1/);
});

test("DDL stays refused with every flag on", async () => {
  const { tools, calls } = harness(registerWriteTools, WRITE_RESULT, [EVERYTHING]);
  for (const sql of ["DROP TABLE t", "TRUNCATE TABLE t", "ALTER TABLE t ADD c INT"]) {
    const result = await tools.execute!({ sql });
    assert.equal(result.isError, true, sql);
    assert.match(textOf(result), /DDL/);
  }
  assert.equal(calls.length, 0);
});

test("UPDATE and DELETE without WHERE need an explicit confirmation", async () => {
  const { tools, calls } = harness(registerWriteTools, WRITE_RESULT, [EVERYTHING]);

  for (const sql of ["DELETE FROM users", "UPDATE users SET active = 0"]) {
    const result = await tools.execute!({ sql });
    assert.equal(result.isError, true, sql);
    assert.match(textOf(result), /allow_full_table=true/);
  }
  assert.equal(calls.length, 0, "the unconfirmed statement must not run");

  // Confirmed, it goes through.
  const confirmed = await tools.execute!({ sql: "DELETE FROM users", allow_full_table: true });
  assert.notEqual(confirmed.isError, true);
  assert.equal(calls.length, 1);
});

test("a bounded write needs no confirmation", async () => {
  const { tools, calls } = harness(registerWriteTools, WRITE_RESULT, [EVERYTHING]);
  await tools.execute!({ sql: "DELETE FROM users WHERE id = 1" });
  await tools.execute!({ sql: "DELETE FROM users LIMIT 1" });
  assert.equal(calls.length, 2);
});

test("a read sent to execute is redirected to query", async () => {
  const { tools, calls } = harness(registerWriteTools, WRITE_RESULT, [EVERYTHING]);
  const result = await tools.execute!({ sql: "SELECT 1" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /query/);
  assert.equal(calls.length, 0);
});

test("an UPDATE that matched but changed nothing explains the difference", async () => {
  const { tools } = harness(
    registerWriteTools,
    { write: { affectedRows: 5, changedRows: 0, durationMs: 2 } },
    [EVERYTHING],
  );
  const text = textOf(await tools.execute!({ sql: "UPDATE t SET a = 1 WHERE b = 2" }));
  assert.match(text, /Совпало строк: 5/);
  assert.match(text, /реально изменено: 0/);
});

test("multi-statement payloads are refused", async () => {
  const { tools, calls } = harness(registerWriteTools, WRITE_RESULT, [EVERYTHING]);
  const result = await tools.execute!({ sql: "INSERT INTO t (a) VALUES (1); DROP TABLE t" });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
});
