import assert from "node:assert/strict";
import test from "node:test";
import { registerServerTools } from "./server.js";
import { harness, rows, textOf } from "./harness.js";
import { loadConfig } from "../config.js";

const CONFIG = loadConfig({
  MYSQL_HOST: "db.example.com",
  MYSQL_USER: "reader",
  MYSQL_PASS: "hunter2",
  MYSQL_DB: "shop",
  MYSQL_SSL: "true",
  ALLOW_INSERT_OPERATION: "true",
});

const METHODS = {
  serverInfo: rows([{ server_version: "8.0.36", current_database: "shop", effective_user: "reader@%" }]),
  databaseSize: rows([{ tables: 12, data_bytes: 1024, index_bytes: 256, rows_estimate: 900 }]),
  grants: ["GRANT SELECT ON `shop`.* TO `reader`@`%`"],
};

test("server_info reports the connection, the size and both permission layers", async () => {
  const { tools, configs } = harness(registerServerTools, METHODS, [CONFIG]);
  assert.equal(configs.server_info?.annotations?.readOnlyHint, true);

  const result = JSON.parse(textOf(await tools.server_info!({})));

  assert.equal(result.connection.server_version, "8.0.36");
  assert.equal(result.connection.host, "db.example.com:3306");
  assert.deepEqual(result.connection.tls, { enabled: true, verify_certificate: true });
  assert.equal(result.database_size.tables, 12);
  // The two independent walls: what MySQL grants and what this server allows.
  assert.match(JSON.stringify(result.grants), /GRANT SELECT/);
  assert.deepEqual(result.server_limits.allowed_writes, { insert: true, update: false, delete: false });
  assert.equal(result.server_limits.ddl, false);
  assert.equal(result.server_limits.max_rows_per_read, CONFIG.maxRows);
});

test("the password never appears in the answer", async () => {
  const { tools } = harness(registerServerTools, METHODS, [CONFIG]);
  assert.equal(textOf(await tools.server_info!({})).includes("hunter2"), false);
});

test("an account that cannot SHOW GRANTS still gets an answer", async () => {
  // SHOW GRANTS is privileged on some managed setups; its absence is a fact
  // about the account, not a failed call.
  const { tools } = harness(registerServerTools, METHODS, [CONFIG], { throwOn: "grants" });
  const result = await tools.server_info!({});

  assert.notEqual(result.isError, true);
  assert.match(textOf(result), /SHOW GRANTS недоступен/);
});

test("a failure of the main query is reported as an error", async () => {
  const { tools } = harness(registerServerTools, METHODS, [CONFIG], { throwOn: "serverInfo" });
  const result = await tools.server_info!({});
  assert.equal(result.isError, true);
});
