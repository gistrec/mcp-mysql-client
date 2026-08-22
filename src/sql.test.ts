import assert from "node:assert/strict";
import test from "node:test";
import { analyze, assertReadable, assertWritable, isBounded, scan } from "./sql.js";
import { PermissionError, ValidationError, type Permissions } from "./types.js";

const NOTHING: Permissions = { insert: false, update: false, delete: false };
const EVERYTHING: Permissions = { insert: true, update: true, delete: true };

test("classifies the ordinary read statements", () => {
  for (const sql of [
    "SELECT 1",
    "select id, name from users where id = ?",
    "SHOW TABLES",
    "DESCRIBE users",
    "DESC users",
    "TABLE users",
    "WITH recent AS (SELECT * FROM orders) SELECT * FROM recent",
  ]) {
    assert.equal(analyze(sql).kind, "read", sql);
  }
});

test("classifies writes by verb", () => {
  assert.equal(analyze("INSERT INTO t (a) VALUES (1)").kind, "insert");
  assert.equal(analyze("UPDATE t SET a = 1 WHERE id = 2").kind, "update");
  assert.equal(analyze("DELETE FROM t WHERE id = 2").kind, "delete");
  assert.equal(analyze("REPLACE INTO t (a) VALUES (1)").kind, "replace");
});

test("DDL is its own class and is never permitted", () => {
  for (const sql of ["DROP TABLE t", "CREATE TABLE t (a INT)", "ALTER TABLE t ADD b INT", "TRUNCATE TABLE t", "RENAME TABLE a TO b"]) {
    assert.equal(analyze(sql).kind, "ddl", sql);
    assert.throws(() => assertWritable(analyze(sql), EVERYTHING), PermissionError, sql);
  }
});

test("statements that would escape the sandbox are forbidden with a reason", () => {
  for (const sql of [
    "USE other_db",
    "SET SESSION transaction_isolation = 'READ-UNCOMMITTED'",
    "CALL some_procedure()",
    "LOAD DATA LOCAL INFILE '/etc/passwd' INTO TABLE t",
    "PREPARE stmt FROM 'DELETE FROM t'",
    "EXECUTE stmt",
    "START TRANSACTION",
    "COMMIT",
    "LOCK TABLES t WRITE",
    "GRANT ALL ON *.* TO 'x'@'%'",
    "KILL 42",
    "FLUSH PRIVILEGES",
    "OPTIMIZE TABLE t",
    "ANALYZE TABLE t",
  ]) {
    const analysis = analyze(sql);
    assert.equal(analysis.kind, "forbidden", sql);
    assert.ok(analysis.reason, `${sql} must explain itself`);
    assert.throws(() => assertReadable(analysis), PermissionError, sql);
    assert.throws(() => assertWritable(analysis, EVERYTHING), PermissionError, sql);
  }
});

test("keywords inside string literals and quoted identifiers are not verbs", () => {
  // The whole point of the scanner: this is a read, however much it looks otherwise.
  assert.equal(analyze("SELECT * FROM logs WHERE message = 'DROP TABLE users'").kind, "read");
  assert.equal(analyze('SELECT * FROM logs WHERE message = "DELETE FROM users"').kind, "read");
  assert.equal(analyze("SELECT `delete`, `update` FROM t").kind, "read");
  // A doubled quote is an escaped quote, not the end of the literal.
  assert.equal(analyze("SELECT * FROM t WHERE a = 'it''s; DROP TABLE x'").kind, "read");
  // Backslash escapes apply inside strings (NO_BACKSLASH_ESCAPES off).
  assert.equal(analyze("SELECT * FROM t WHERE a = 'quote \\' ; DELETE FROM x'").kind, "read");
});

test("comments are stripped, and the executable kind is refused outright", () => {
  assert.equal(analyze("-- a comment\nSELECT 1").kind, "read");
  assert.equal(analyze("SELECT 1 # trailing").kind, "read");
  assert.equal(analyze("SELECT /* inline */ 1").kind, "read");
  assert.equal(analyze("SELECT /*+ MAX_EXECUTION_TIME(1000) */ 1").kind, "read");
  // `/*!` is executed by MySQL, so stripping it would hide the real statement.
  assert.throws(() => analyze("SELECT 1 /*!50000 , (SELECT 1) */"), ValidationError);
  assert.throws(() => analyze("/*!32302 DELETE FROM t */"), ValidationError);
  // A comment must not glue two words together.
  assert.equal(analyze("SELECT/**/1").verb, "SELECT");
});

test("a CTE cannot smuggle a write past the read gate", () => {
  assert.equal(analyze("WITH x AS (SELECT id FROM t) DELETE FROM t WHERE id IN (SELECT id FROM x)").kind, "delete");
  assert.equal(analyze("WITH x AS (SELECT 1) UPDATE t SET a = 1 WHERE id = 1").kind, "update");
  assert.throws(
    () => assertReadable(analyze("WITH x AS (SELECT 1) DELETE FROM t WHERE id = 1")),
    PermissionError,
  );
});

test("EXPLAIN is classified by the statement it explains", () => {
  assert.equal(analyze("EXPLAIN SELECT 1").kind, "read");
  assert.equal(analyze("EXPLAIN FORMAT=JSON SELECT 1").kind, "read");
  assert.equal(analyze("EXPLAIN ANALYZE SELECT 1").kind, "read");
  assert.equal(analyze("EXPLAIN users").kind, "read");
  // EXPLAIN ANALYZE runs what it explains, so a write stays a write.
  assert.equal(analyze("EXPLAIN DELETE FROM t WHERE id = 1").kind, "delete");
  assert.equal(analyze("EXPLAIN ANALYZE UPDATE t SET a = 1").kind, "update");
});

test("SELECT that writes a file is refused", () => {
  const analysis = analyze("SELECT * FROM users INTO OUTFILE '/tmp/dump.csv'");
  assert.equal(analysis.kind, "forbidden");
  assert.match(analysis.reason ?? "", /OUTFILE/);
  assert.throws(() => assertReadable(analysis), PermissionError);
});

test("only one statement runs per call", () => {
  assert.throws(() => analyze("SELECT 1; SELECT 2"), ValidationError);
  assert.throws(() => analyze("SELECT 1; DROP TABLE t"), ValidationError);
  // A trailing semicolon is still a single statement.
  assert.equal(analyze("SELECT 1;").kind, "read");
  assert.equal(analyze("SELECT 1;  ").kind, "read");
  assert.throws(() => analyze(""), ValidationError);
  assert.throws(() => analyze("   "), ValidationError);
});

test("unterminated quotes and comments are rejected, not guessed at", () => {
  assert.throws(() => analyze("SELECT 'unclosed"), ValidationError);
  assert.throws(() => analyze("SELECT `unclosed"), ValidationError);
  assert.throws(() => analyze("SELECT 1 /* unclosed"), ValidationError);
});

test("the statement is normalized: comments out, trailing semicolon gone", () => {
  const analysis = analyze("SELECT 1 -- trailing comment\n;");
  assert.equal(analysis.statement.includes("--"), false);
  assert.equal(analysis.statement.endsWith(";"), false);
});

test("assertReadable refuses writes even when they are permitted elsewhere", () => {
  // Being allowed to DELETE does not make DELETE a read: the write tool is
  // where a destructive call is visible as such.
  assert.throws(() => assertReadable(analyze("DELETE FROM t WHERE id = 1")), PermissionError);
  assert.throws(() => assertReadable(analyze("INSERT INTO t (a) VALUES (1)")), PermissionError);
  assert.doesNotThrow(() => assertReadable(analyze("SELECT 1")));
});

test("write permissions name the exact variable that is missing", () => {
  assert.throws(
    () => assertWritable(analyze("INSERT INTO t (a) VALUES (1)"), NOTHING),
    (err: unknown) => err instanceof PermissionError && /ALLOW_INSERT_OPERATION=true/.test(err.message),
  );
  assert.throws(
    () => assertWritable(analyze("UPDATE t SET a = 1 WHERE id = 1"), { ...NOTHING, insert: true }),
    (err: unknown) => err instanceof PermissionError && /ALLOW_UPDATE_OPERATION=true/.test(err.message),
  );
  assert.doesNotThrow(() => assertWritable(analyze("UPDATE t SET a = 1 WHERE id = 1"), EVERYTHING));
});

test("REPLACE needs the delete grant too, because it deletes the colliding row", () => {
  assert.throws(
    () => assertWritable(analyze("REPLACE INTO t (a) VALUES (1)"), { insert: true, update: true, delete: false }),
    (err: unknown) => err instanceof PermissionError && /ALLOW_DELETE_OPERATION=true/.test(err.message),
  );
  assert.doesNotThrow(() => assertWritable(analyze("REPLACE INTO t (a) VALUES (1)"), EVERYTHING));
});

test("a read sent to the write tool is redirected, not just refused", () => {
  assert.throws(
    () => assertWritable(analyze("SELECT 1"), EVERYTHING),
    (err: unknown) => err instanceof PermissionError && /query/.test(err.message),
  );
});

test("isBounded sees WHERE and LIMIT", () => {
  assert.equal(isBounded(analyze("DELETE FROM t")), false);
  assert.equal(isBounded(analyze("UPDATE t SET a = 1")), false);
  assert.equal(isBounded(analyze("DELETE FROM t WHERE id = 1")), true);
  assert.equal(isBounded(analyze("DELETE FROM t LIMIT 10")), true);
  // A WHERE inside a string is not a WHERE.
  assert.equal(isBounded(analyze("DELETE FROM t /* where */")), false);
});

test("scan splits on semicolons outside literals only", () => {
  assert.equal(scan("SELECT ';'").length, 1);
  assert.equal(scan("SELECT 1; SELECT 2").length, 2);
  assert.equal(scan("SELECT 1;;;").length, 1);
});
