import assert from "node:assert/strict";
import test from "node:test";
import { fail, ok } from "./util.js";
import { MysqlError, PermissionError, TimeoutError, ValidationError } from "../types.js";

/** Text of a tool result, for assertions. */
function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((part) => part.text ?? "").join(" ");
}

test("ok() emits compact JSON — pretty-printing a result set burns tokens", () => {
  const result = ok({ rows: [{ id: 1 }] });
  assert.equal(textOf(result), '{"rows":[{"id":1}]}');
  assert.notEqual(result.isError, true);
  // A string passes through as itself rather than being re-quoted.
  assert.equal(textOf(ok("готово")), "готово");
});

test("the three access-denied errors get three different fixes", () => {
  // They read almost identically to a human and mean the password, the grant
  // on the database and the grant on the table respectively.
  assert.match(textOf(fail(new MysqlError("Access denied", { errno: 1045 }))), /MYSQL_USER и MYSQL_PASS/);
  assert.match(textOf(fail(new MysqlError("Access denied for db", { errno: 1044 }))), /GRANT на базу/);
  assert.match(textOf(fail(new MysqlError("Access denied for table", { errno: 1142 }))), /GRANT/);
  // And the table-level one says explicitly that ALLOW_* is the wrong lever.
  assert.match(textOf(fail(new MysqlError("x", { errno: 1142 }))), /ALLOW_\*_OPERATION его не расширяют/);
});

test("connection-level codes point at the connection, not at a grant", () => {
  assert.match(textOf(fail(new MysqlError("connect ECONNREFUSED", { code: "ECONNREFUSED" }))), /MYSQL_HOST/);
  assert.match(textOf(fail(new MysqlError("getaddrinfo", { code: "ENOTFOUND" }))), /имя хоста/);
  assert.match(textOf(fail(new MysqlError("timeout", { code: "ETIMEDOUT" }))), /файрвол|VPN/);
  assert.match(textOf(fail(new MysqlError("lost", { code: "PROTOCOL_CONNECTION_LOST" }))), /оборвалось/);
});

test("TLS failures name the variable that fixes them", () => {
  assert.match(textOf(fail(new MysqlError("secure transport required", { errno: 3159 }))), /MYSQL_SSL=true/);
  assert.match(
    textOf(fail(new MysqlError("self signed", { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }))),
    /MYSQL_SSL_CA/,
  );
  assert.match(textOf(fail(new MysqlError("no ssl", { code: "HANDSHAKE_NO_SSL_SUPPORT" }))), /снимите флаг/);
});

test("a write refused by the read-only transaction points at the write tool", () => {
  // This is the second line of defence firing: sql.ts should have caught it,
  // and the message has to make the next step obvious anyway.
  assert.match(textOf(fail(new MysqlError("read only", { errno: 1792 }))), /execute/);
});

test("errors carry the errno so the failure can be looked up", () => {
  assert.match(textOf(fail(new MysqlError("boom", { errno: 1146 }))), /\[errno 1146\]/);
});

test("policy and validation failures are rendered without a database hint", () => {
  const permission = fail(new PermissionError("DELETE запрещён", "delete"));
  assert.equal(permission.isError, true);
  assert.match(textOf(permission), /DELETE запрещён/);
  assert.equal(textOf(permission).includes("errno"), false);

  assert.match(textOf(fail(new ValidationError("Пустой SQL-запрос."))), /Пустой SQL-запрос/);
  assert.match(textOf(fail(new TimeoutError(30000))), /30000 мс/);
});

test("the underlying cause is surfaced instead of being swallowed", () => {
  const err = new Error("не удалось выполнить запрос");
  err.cause = new Error("socket hang up");
  assert.match(textOf(fail(err)), /socket hang up/);
});

test("an unknown errno still produces a usable message", () => {
  const text = textOf(fail(new MysqlError("Something unusual happened", { errno: 9999 })));
  assert.match(text, /Something unusual happened/);
  assert.match(text, /\[errno 9999\]/);
});
