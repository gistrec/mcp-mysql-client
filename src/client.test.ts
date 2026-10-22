import assert from "node:assert/strict";
import test from "node:test";
import { MysqlClient, normalizeRow } from "./client.js";
import { loadConfig } from "./config.js";
import { CredentialsError, TimeoutError } from "./types.js";

test("without credentials every path fails with the fix, not a connection attempt", async () => {
  const client = new MysqlClient(loadConfig({}));

  for (const call of [
    () => client.read("SELECT 1"),
    () => client.write("INSERT INTO t (a) VALUES (1)"),
    () => client.listTables(),
    () => client.serverInfo(),
  ]) {
    await assert.rejects(call, (err: unknown) => {
      assert.ok(err instanceof CredentialsError, "must be a CredentialsError, not a socket error");
      // The message is the product: it names the variables and says to restart.
      assert.match(err.message, /MYSQL_USER/);
      assert.match(err.message, /MYSQL_DB/);
      assert.match(err.message, /перезапустите сервер/);
      return true;
    });
  }
});

test("a config problem rides along into the credentials error", async () => {
  const client = new MysqlClient({
    ...loadConfig({}),
    configProblem: "MYSQL_PORT должен быть целым числом",
  });
  await assert.rejects(
    () => client.read("SELECT 1"),
    (err: unknown) => err instanceof CredentialsError && /MYSQL_PORT/.test(err.message),
  );
});

test("close() is safe before a pool ever exists", async () => {
  const client = new MysqlClient(loadConfig({}));
  await client.close();
  await client.close();
});

test("binary columns become base64 instead of a per-byte JSON array", () => {
  const row = normalizeRow({ id: 1, blob: Buffer.from("hello") });
  assert.deepEqual(row, { id: 1, blob: { base64: Buffer.from("hello").toString("base64"), bytes: 5 } });
  // The naive shape is what this exists to prevent.
  assert.equal(JSON.stringify(row).includes('"type":"Buffer"'), false);
});

test("a large binary column is truncated with the real size kept", () => {
  const big = Buffer.alloc(5000, 7);
  const row = normalizeRow({ data: big }) as { data: { bytes: number; truncated: boolean; base64: string } };
  assert.equal(row.data.bytes, 5000);
  assert.equal(row.data.truncated, true);
  assert.ok(row.data.base64.length < 500, "the payload must not travel in full");
});

test("rows without binary columns are passed through untouched", () => {
  const row = { id: 1, name: "Анна", price: "10.50", created_at: "2026-08-21 10:00:00", meta: null };
  // Identity, not a copy: normalizing every row of a large result set would be
  // pure overhead for the common case.
  assert.equal(normalizeRow(row), row);
  assert.equal(normalizeRow(null), null);
  assert.equal(normalizeRow(42), 42);
});

test("a statement that never answers settles with a timeout instead of hanging", async () => {
  const config = { ...loadConfig({ MYSQL_USER: "u", MYSQL_DB: "d", MYSQL_TIMEOUT_MS: "50" }), maxRetries: 0 };
  const client = new MysqlClient(config);
  let socketDropped = false;
  // What mysql2 does on a dead link: destroy() marks the connection closing,
  // and the command in flight never hears back.
  const never = new Promise<never>(() => {});
  const conn = {
    query: () => never,
    destroy: () => {},
    release: () => {},
    connection: { query: () => ({ on: () => {}, stream: () => never }), stream: { destroy: () => (socketDropped = true) } },
  };
  (client as unknown as { pool: unknown }).pool = { getConnection: async () => conn };

  for (const call of [() => client.read("SELECT 1"), () => client.write("INSERT INTO t (a) VALUES (1)")]) {
    socketDropped = false;
    await assert.rejects(call, (err: unknown) => err instanceof TimeoutError);
    assert.ok(socketDropped, "the socket itself must be dropped, not just ended");
  }
});
