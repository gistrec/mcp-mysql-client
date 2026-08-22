import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ConfigError,
  DEFAULT_MAX_ROWS,
  DEFAULT_PORT,
  boolean,
  describePermissions,
  describeTarget,
  hasCredentials,
  loadConfig,
  missingCredentials,
} from "./config.js";

const BASE = { MYSQL_HOST: "db.example.com", MYSQL_USER: "reader", MYSQL_PASS: "s3cret", MYSQL_DB: "shop" };

test("reads a complete environment", () => {
  const config = loadConfig({ ...BASE, MYSQL_PORT: "3307" });
  assert.equal(config.host, "db.example.com");
  assert.equal(config.port, 3307);
  assert.equal(config.user, "reader");
  assert.equal(config.password, "s3cret");
  assert.equal(config.database, "shop");
  assert.equal(hasCredentials(config), true);
});

test("defaults are the safe ones: no writes, a row cap, verified TLS when TLS is on", () => {
  const config = loadConfig(BASE);
  assert.equal(config.port, DEFAULT_PORT);
  assert.deepEqual(config.permissions, { insert: false, update: false, delete: false });
  assert.equal(config.maxRows, DEFAULT_MAX_ROWS);
  assert.equal(config.readOnlyTransactions, true);
  assert.equal(config.ssl, undefined);
  assert.equal(loadConfig({ ...BASE, MYSQL_SSL: "true" }).ssl?.rejectUnauthorized, true);
});

test("missing credentials are not an error — the server must still start", () => {
  const config = loadConfig({});
  assert.equal(hasCredentials(config), false);
  // The host has a default, so only the two identity variables are named.
  assert.deepEqual(missingCredentials(config), ["MYSQL_USER", "MYSQL_DB"]);
  assert.equal(config.user, undefined);
});

test("an empty string reads as absent, never as an empty credential", () => {
  const config = loadConfig({ MYSQL_USER: "", MYSQL_DB: "  ", MYSQL_HOST: "" });
  assert.equal(config.user, undefined);
  assert.equal(config.database, undefined);
  assert.equal(config.host, "127.0.0.1");
});

test("MYSQL_DATABASE is accepted as an alias of MYSQL_DB", () => {
  assert.equal(loadConfig({ ...BASE, MYSQL_DB: "", MYSQL_DATABASE: "other" }).database, "other");
  assert.equal(loadConfig({ ...BASE, MYSQL_PASS: "", MYSQL_PASSWORD: "pw" }).password, "pw");
});

test("a malformed port throws ConfigError instead of being guessed at", () => {
  for (const port of ["not-a-number", "3306abc", "0", "70000", "-1"]) {
    assert.throws(
      () => loadConfig({ ...BASE, MYSQL_PORT: port }),
      (err: unknown) => err instanceof ConfigError && err.reason === "invalid_port",
      port,
    );
  }
});

test("write permissions only open on an explicit truthy word", () => {
  const on = loadConfig({ ...BASE, ALLOW_INSERT_OPERATION: "true", ALLOW_UPDATE_OPERATION: "1", ALLOW_DELETE_OPERATION: "yes" });
  assert.deepEqual(on.permissions, { insert: true, update: true, delete: true });

  // Anything unparseable must not open a write permission.
  const garbage = loadConfig({ ...BASE, ALLOW_INSERT_OPERATION: "maybe", ALLOW_DELETE_OPERATION: "sure" });
  assert.deepEqual(garbage.permissions, { insert: false, update: false, delete: false });

  const off = loadConfig({ ...BASE, ALLOW_INSERT_OPERATION: "false", ALLOW_UPDATE_OPERATION: "off" });
  assert.deepEqual(off.permissions, { insert: false, update: false, delete: false });
});

test("boolean() keeps the default when the value is unparseable", () => {
  assert.equal(boolean(undefined, true), true);
  assert.equal(boolean("", true), true);
  assert.equal(boolean("nonsense", true), true);
  assert.equal(boolean("nonsense", false), false);
  assert.equal(boolean("OFF", true), false);
});

test("a CA path implies TLS, and an unreadable one is a ConfigError", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-mysql-"));
  const caPath = join(dir, "ca.pem");
  writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n");

  // No MYSQL_SSL at all: pointing at a CA is itself the request for TLS.
  const config = loadConfig({ ...BASE, MYSQL_SSL_CA: caPath });
  assert.match(config.ssl?.ca ?? "", /BEGIN CERTIFICATE/);
  assert.equal(config.ssl?.rejectUnauthorized, true);

  assert.equal(
    loadConfig({ ...BASE, MYSQL_SSL_CA: caPath, MYSQL_SSL_REJECT_UNAUTHORIZED: "false" }).ssl?.rejectUnauthorized,
    false,
  );

  assert.throws(
    () => loadConfig({ ...BASE, MYSQL_SSL_CA: join(dir, "missing.pem") }),
    (err: unknown) => err instanceof ConfigError && err.reason === "unreadable_ssl_ca",
  );
});

test("the password can come from a file, and a bad path is not silently ignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-mysql-"));
  const passFile = join(dir, "pass");
  writeFileSync(passFile, "from-file\n");

  // The trailing newline every editor adds must not become part of the password.
  assert.equal(loadConfig({ ...BASE, MYSQL_PASS_FILE: passFile }).password, "from-file");

  assert.throws(
    () => loadConfig({ ...BASE, MYSQL_PASS_FILE: join(dir, "nope") }),
    (err: unknown) => err instanceof ConfigError && err.reason === "unreadable_pass_file",
  );
});

test("a socket path replaces host and port", () => {
  const config = loadConfig({ ...BASE, MYSQL_SOCKET_PATH: "/tmp/mysql.sock" });
  assert.equal(config.socketPath, "/tmp/mysql.sock");
  assert.equal(config.host, undefined);
  assert.equal(hasCredentials(config), true);
});

test("describeTarget is safe to print: it never carries the password", () => {
  const config = loadConfig({ ...BASE, MYSQL_PASS: "hunter2" });
  const described = describeTarget(config);
  assert.equal(described.includes("hunter2"), false);
  assert.match(described, /reader@db\.example\.com:3306\/shop/);
  assert.equal(describeTarget(loadConfig({})), "подключение не настроено");
});

test("describePermissions states the mode in words", () => {
  assert.equal(describePermissions({ insert: false, update: false, delete: false }), "только чтение");
  assert.match(describePermissions({ insert: true, update: false, delete: false }), /INSERT/);
  assert.match(describePermissions({ insert: true, update: true, delete: true }), /INSERT, UPDATE, DELETE/);
});

test("numeric limits fall back instead of becoming NaN", () => {
  const config = loadConfig({ ...BASE, MYSQL_MAX_ROWS: "abc", MYSQL_TIMEOUT_MS: "0", MYSQL_MAX_RETRIES: "0" });
  assert.equal(config.maxRows, DEFAULT_MAX_ROWS);
  assert.ok(config.timeoutMs > 0);
  // Zero retries is a meaningful choice, unlike zero rows or a zero timeout.
  assert.equal(config.maxRetries, 0);
});
