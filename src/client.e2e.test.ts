/**
 * End-to-end tests against a real server. Skipped unless MYSQL_E2E=1 — CI
 * starts MySQL and MariaDB as service containers and sets it; locally point
 * MYSQL_HOST/MYSQL_PORT/MYSQL_USER/MYSQL_PASS/MYSQL_DB at a throwaway server.
 *
 * The user needs CREATE/DROP on MYSQL_DB and the right to KILL its own
 * connections; root in a container has both.
 */
import assert from "node:assert/strict";
import net from "node:net";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { MysqlClient } from "./client.js";
import { loadConfig } from "./config.js";
import { MysqlError, TimeoutError, type MysqlConfig } from "./types.js";

const enabled = process.env.MYSQL_E2E === "1";

function config(overrides: Partial<MysqlConfig> = {}): MysqlConfig {
  return { ...loadConfig(process.env), ...overrides };
}

/**
 * A TCP relay that can stop relaying without closing anything — what a NAT
 * that lost its mapping looks like from the client: writes vanish, no FIN,
 * no RST.
 */
async function blackholeProxy(target: { host: string; port: number }) {
  let blackhole = false;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((inbound) => {
    const upstream = net.connect(target.port, target.host);
    for (const s of [inbound, upstream]) {
      sockets.add(s);
      s.on("error", () => {});
    }
    inbound.on("data", (d) => blackhole || upstream.write(d));
    upstream.on("data", (d) => blackhole || inbound.write(d));
    inbound.on("close", () => blackhole || upstream.destroy());
    upstream.on("close", () => blackhole || inbound.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    set blackhole(on: boolean) {
      blackhole = on;
    },
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

describe("e2e against a real server", { skip: !enabled && "MYSQL_E2E не задан" }, () => {
  let client: MysqlClient;

  before(async () => {
    client = new MysqlClient(config());
    await client.write("DROP TABLE IF EXISTS e2e_items");
    await client.write(
      "CREATE TABLE e2e_items (id INT PRIMARY KEY, name VARCHAR(32), price DECIMAL(10,2), created DATE)",
    );
    await client.write("INSERT INTO e2e_items VALUES (1, 'Анна', 10.50, '2026-08-21'), (2, 'Борис', 3.00, '2026-08-22')");
  });

  after(async () => {
    await client.write("DROP TABLE IF EXISTS e2e_items");
    await client.close();
  });

  test("a read returns rows in model-safe shapes", async () => {
    const result = await client.read("SELECT * FROM e2e_items WHERE id = ?", [1]);
    assert.deepEqual(result.rows, [{ id: 1, name: "Анна", price: "10.50", created: "2026-08-21" }]);
    assert.equal(result.truncated, false);
    assert.deepEqual(
      result.columns?.map((c) => c.name),
      ["id", "name", "price", "created"],
    );
  });

  test("the row cap cuts the result and leaves the pool usable", async () => {
    const result = await client.read("SELECT id FROM e2e_items ORDER BY id", [], { maxRows: 1 });
    assert.deepEqual(result.rows, [{ id: 1 }]);
    assert.equal(result.truncated, true);
    assert.deepEqual((await client.read("SELECT COUNT(*) AS n FROM e2e_items")).rows, [{ n: 2 }]);
  });

  test("a read cannot write: it runs inside a read-only transaction", async () => {
    await assert.rejects(client.read("DELETE FROM e2e_items"), MysqlError);
    assert.deepEqual((await client.read("SELECT COUNT(*) AS n FROM e2e_items")).rows, [{ n: 2 }]);
  });

  test("schema introspection sees the table", async () => {
    const tables = await client.listTables();
    assert.ok(tables.rows.some((row) => (row as { name: string }).name === "e2e_items"));
    const columns = await client.tableColumns("e2e_items");
    assert.equal(columns.rowCount, 4);
  });

  test("a connection killed by the server is replaced, not reused", async () => {
    const [{ id }] = (await client.read("SELECT CONNECTION_ID() AS id")).rows as { id: number }[];
    const killer = new MysqlClient(config());
    try {
      await killer.write(`KILL ${Number(id)}`);
    } finally {
      await killer.close();
    }
    assert.deepEqual((await client.read("SELECT 1 AS ok")).rows, [{ ok: 1 }]);
  });

  test("a dead link settles with a timeout and the next call reconnects", async () => {
    const base = config();
    const proxy = await blackholeProxy({ host: base.host ?? "127.0.0.1", port: base.port });
    const viaProxy = new MysqlClient({ ...base, host: "127.0.0.1", port: proxy.port, timeoutMs: 1000, maxRetries: 0 });
    try {
      assert.deepEqual((await viaProxy.read("SELECT 1 AS ok")).rows, [{ ok: 1 }]);
      proxy.blackhole = true;
      const started = Date.now();
      await assert.rejects(viaProxy.read("SELECT 2 AS ok"), TimeoutError);
      assert.ok(Date.now() - started < 5000, "the call must settle near the deadline, not hang");
      proxy.blackhole = false;
      assert.deepEqual((await viaProxy.read("SELECT 3 AS ok")).rows, [{ ok: 3 }]);
    } finally {
      await viaProxy.close();
      await proxy.close();
    }
  });

  test("the built server answers a query tool call over stdio", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
      env: { ...(process.env as Record<string, string>), ASKADS_TELEMETRY: "0" },
      stderr: "ignore",
    });
    const mcp = new Client({ name: "e2e", version: "0.0.0" });
    await mcp.connect(transport);
    try {
      const result = (await mcp.callTool({
        name: "query",
        arguments: { sql: "SELECT name FROM e2e_items WHERE id = ?", params: [2] },
      })) as { content: { text: string }[]; isError?: boolean };
      assert.ok(!result.isError, result.content[0]?.text);
      assert.deepEqual(JSON.parse(result.content[0].text).rows, [{ name: "Борис" }]);
    } finally {
      await mcp.close();
    }
  });
});
