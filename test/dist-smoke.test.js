/**
 * Built-artifact smoke test: everything here runs against `dist/`, not `src/`.
 *
 * It spawns the published entrypoint exactly as an MCP host would — `node
 * dist/index.js` over stdio — completes the handshake, lists the tools and
 * calls a few. That catches the failures a source test structurally cannot: a
 * missing `#!/usr/bin/env node`, a register* call left out of index.ts, an
 * import that only resolves under tsx, a tool whose zod shape throws during
 * JSON-schema conversion, or annotations dropped by the build.
 *
 * No database is touched. The tool calls all run in the unconfigured state,
 * where every path fails before a socket is opened — which is also the
 * behaviour worth pinning: refusals must be cheap and must precede connecting.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ENTRYPOINT = fileURLToPath(new URL("../dist/index.js", import.meta.url));

/** Every tool the assembled server must expose, with the annotations it ships. */
const EXPECTED = {
  // server.ts
  server_info: "READ_ONLY",
  // schema.ts
  list_tables: "READ_ONLY",
  describe_table: "READ_ONLY",
  // query.ts
  query: "READ_ONLY",
  explain: "READ_ONLY",
  // write.ts
  execute: "DESTRUCTIVE",
};

/** The four hints behind each label above — mirrors src/tools/util.ts. */
const ANNOTATIONS = {
  READ_ONLY: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  DESTRUCTIVE: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

/**
 * Handshakes with a freshly spawned dist server. The credentials are
 * syntactically valid but point nowhere — startup must not open a connection,
 * and if it ever did, this would fail instead of reaching a real database.
 */
async function connectToDist(env, name) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRYPOINT],
    env: {
      PATH: process.env.PATH ?? "",
      // Never ping the telemetry endpoint from a test run.
      ASKADS_TELEMETRY: "0",
      ...env,
    },
    stderr: "ignore",
  });
  const client = new Client({ name, version: "0" });
  await client.connect(transport);
  return client;
}

const CONFIGURED = {
  MYSQL_HOST: "127.0.0.1",
  MYSQL_PORT: "3306",
  MYSQL_USER: "test",
  MYSQL_PASS: "test",
  MYSQL_DB: "test",
};

/** Joins a call result's text content. */
function textOf(result) {
  return result.content.map((part) => part.text ?? "").join(" ");
}

test("dist server handshakes over stdio and exposes the full tool set", async () => {
  const client = await connectToDist(CONFIGURED, "dist-smoke");
  try {
    const version = client.getServerVersion();
    assert.equal(version?.name, "mcp-mysql-client");
    assert.match(version?.version ?? "", /^\d+\.\d+\.\d+/);

    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), Object.keys(EXPECTED).sort());
  } finally {
    await client.close();
  }
});

test("dist tools keep their annotations, descriptions and input schemas", async () => {
  const client = await connectToDist(CONFIGURED, "dist-smoke-annotations");
  try {
    const { tools } = await client.listTools();

    for (const tool of tools) {
      const label = EXPECTED[tool.name];
      assert.ok(label, `unexpected tool ${tool.name}`);
      assert.deepEqual(
        {
          readOnlyHint: tool.annotations?.readOnlyHint,
          destructiveHint: tool.annotations?.destructiveHint,
          idempotentHint: tool.annotations?.idempotentHint,
          openWorldHint: tool.annotations?.openWorldHint,
        },
        ANNOTATIONS[label],
        `${tool.name} should ship the ${label} annotations`,
      );

      // A tool the model cannot understand is as good as missing.
      assert.ok((tool.description ?? "").length > 40, `${tool.name} needs a real description`);
      assert.equal(tool.inputSchema?.type, "object", `${tool.name} needs an object input schema`);
      // $ref survives zod-to-json-schema dedup and some consumers do not resolve
      // it, rendering the field as `any`; util.ts's factories exist to avoid it.
      assert.equal(
        JSON.stringify(tool.inputSchema).includes('"$ref"'),
        false,
        `${tool.name} input schema must not contain $ref`,
      );
    }
  } finally {
    await client.close();
  }
});

test("dist server ships usable instructions in the initialize result", async () => {
  const client = await connectToDist(CONFIGURED, "dist-smoke-instructions");
  try {
    const instructions = client.getInstructions() ?? "";
    assert.ok(instructions, "initialize must carry instructions");
    assert.ok(instructions.length > 300, `instructions look truncated (${instructions.length} chars)`);

    // Cheap regression guard on the facts that cost the most to rediscover: a
    // truncated result is a prefix, writes are gated by environment variables,
    // and the server is bound to one database.
    assert.match(instructions, /truncated/);
    assert.match(instructions, /ALLOW_\*_OPERATION/);
    assert.match(instructions, /одной базе данных/);
  } finally {
    await client.close();
  }
});

/**
 * The degraded-start contract: without any credentials the server must still
 * start, list every tool, open the instructions with the fix, and answer a tool
 * call with the actionable error — never exit(1) before the handshake.
 */
test("dist server starts without credentials: handshake, tool list, actionable call error", async () => {
  const client = await connectToDist({}, "dist-smoke-unconfigured");
  try {
    const instructions = client.getInstructions() ?? "";
    assert.match(instructions, /подключение к MySQL не настроено/i);
    assert.match(instructions, /MYSQL_USER/);
    assert.match(instructions, /перезапустить сервер/);

    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), Object.keys(EXPECTED).sort());

    const result = await client.callTool({ name: "query", arguments: { sql: "SELECT 1" } });
    assert.equal(result.isError, true);
    const text = textOf(result);
    assert.match(text, /не настроено/);
    assert.match(text, /MYSQL_USER/);
    assert.match(text, /перезапустите сервер/);
  } finally {
    await client.close();
  }
});

test("dist server survives a malformed port and carries the problem into the session", async () => {
  const client = await connectToDist({ ...CONFIGURED, MYSQL_PORT: "not-a-port" }, "dist-smoke-malformed");
  try {
    const instructions = client.getInstructions() ?? "";
    assert.match(instructions, /Проблема конфигурации: MYSQL_PORT/);

    const result = await client.callTool({ name: "list_tables", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /MYSQL_PORT/);
  } finally {
    await client.close();
  }
});

/**
 * Policy is enforced before connecting, so a refused statement costs nothing
 * and says why. Running unconfigured proves the ordering: if the check came
 * after the connection, these would fail with a credentials error instead.
 */
test("dist server refuses statements by policy before it tries to connect", async () => {
  const client = await connectToDist({}, "dist-smoke-policy");
  try {
    const cases = [
      { tool: "query", args: { sql: "DELETE FROM users WHERE id = 1" }, expect: /execute/ },
      { tool: "query", args: { sql: "DROP TABLE users" }, expect: /DDL|CREATE\/ALTER\/DROP/ },
      { tool: "query", args: { sql: "SELECT 1; SELECT 2" }, expect: /инструкции/ },
      { tool: "execute", args: { sql: "INSERT INTO t (a) VALUES (1)" }, expect: /ALLOW_INSERT_OPERATION/ },
      { tool: "execute", args: { sql: "TRUNCATE TABLE users" }, expect: /DDL/ },
    ];

    for (const { tool, args, expect } of cases) {
      const result = await client.callTool({ name: tool, arguments: args });
      assert.equal(result.isError, true, `${tool} ${args.sql}`);
      const text = textOf(result);
      assert.match(text, expect);
      // The giveaway that the check ran too late: a credentials error means the
      // server went for the connection before judging the statement.
      assert.equal(/не настроено/.test(text), false, `${args.sql} must be refused before connecting`);
    }
  } finally {
    await client.close();
  }
});
