import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { instrumentToolCalls, Telemetry, telemetryEnabled, TOOL_OUTCOMES, toolOutcome } from "./telemetry.js";

interface Sent {
  url: string;
  body: Record<string, unknown>;
}

function recordingFetch(sent: Sent[], fail = false): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    if (fail) throw new Error("network down");
    return new Response("{}", { status: 202 });
  }) as typeof fetch;
}

async function connectedPair(telemetry: Telemetry) {
  const server = new McpServer({ name: "test-server", version: "0.0.0" });
  instrumentToolCalls(server, telemetry);
  server.registerTool(
    "echo",
    { description: "echo", inputSchema: { secret: z.string() } },
    async ({ secret }) => ({ content: [{ type: "text" as const, text: secret }] }),
  );
  const mcp = new Client({ name: "test-client", version: "9.9.9" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  return mcp;
}

test("tool_call reports the tool name and never the SQL", async () => {
  const sent: Sent[] = [];
  const mcp = await connectedPair(new Telemetry("1.0.0", true, recordingFetch(sent)));
  await mcp.callTool({ name: "echo", arguments: { secret: "SELECT * FROM users WHERE email='a@b.c'" } });
  const call = sent.find((s) => s.body.event === "tool_call");
  assert.equal(call?.body.tool, "echo");
  assert.ok(!JSON.stringify(call?.body).includes("users"), "SQL must never reach telemetry");
});

test("MySQL errors map to outcomes without carrying table data", () => {
  const cases: [string, string][] = [
    ["ER_ACCESS_DENIED_ERROR: Access denied for user 'app'@'10.0.0.1'", "error_permission"],
    ["You have an error in your SQL syntax; check the manual near 'FROM'", "error_invalid_request"],
    ["Query timed out after 30000 ms", "error_timeout"],
    ["connect ECONNREFUSED 127.0.0.1:3306", "error_network"],
    ["Duplicate entry 'ivan@example.com' for key 'users.email'", "error_other"],
  ];
  for (const [text, expected] of cases) assert.equal(toolOutcome(errorResult(text)), expected, text);
});

// --- tool outcome ------------------------------------------------------------

const errorResult = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });

test("toolOutcome: success is ok, isError is classified from the text", () => {
  assert.equal(toolOutcome({ content: [{ type: "text", text: "invalid but fine" }] }), "ok");
  const cases: [string, string][] = [
    ["Ошибка: [53] Ошибка авторизации: Недействительный OAuth-токен", "error_auth"],
    ["HTTP 401 Unauthorized", "error_auth"],
    ["Ошибка: [3228] Нет доступа к методу", "error_permission"],
    ["HTTP 403 access_denied: Access Denied", "error_permission"],
    ["HTTP 404 Not Found", "error_not_found"],
    ["Ошибка: [56] Превышен лимит запросов метода", "error_rate_limit"],
    ["HTTP 429 Too Many Requests", "error_rate_limit"],
    ["Ошибка: [8000] Некорректный запрос: Элемент массива FieldNames", "error_invalid_request"],
    ["HTTP 400 invalid_parameter: Incorrectly specified metric", "error_invalid_request"],
    ["HTTP 503 Service Unavailable", "error_upstream"],
    ["Запрос превысил таймаут 30 с", "error_timeout"],
    ["TypeError: fetch failed (ECONNRESET)", "error_network"],
    ["что-то пошло не так", "error_other"],
  ];
  for (const [text, expected] of cases) assert.equal(toolOutcome(errorResult(text)), expected, text);
});

test("toolOutcome: a thrown error is classified, unknown ones are error_internal", () => {
  assert.equal(toolOutcome(undefined, new Error("HTTP 401")), "error_auth");
  assert.equal(toolOutcome(undefined, new TypeError("x is undefined")), "error_internal");
  assert.equal(toolOutcome(undefined, "not even an Error"), "error_internal");
});

test("toolOutcome only ever returns a TOOL_OUTCOMES constant", () => {
  const junk = ["", "a".repeat(10_000), "user@example.com 79991234567", "[53]", "\u0000", "HTTP 418"];
  for (const text of junk) {
    assert.ok((TOOL_OUTCOMES as readonly string[]).includes(toolOutcome(errorResult(text))), text);
    assert.ok((TOOL_OUTCOMES as readonly string[]).includes(toolOutcome(undefined, new Error(text))), text);
  }
  assert.equal(toolOutcome({ isError: true }), "error_other");
  assert.equal(toolOutcome({ isError: true, content: "not an array" }), "error_other");
});

test("tool_call carries the outcome and never the error text", async () => {
  const sent: Sent[] = [];
  const telemetry = new Telemetry("1.0.0", true, recordingFetch(sent));
  const server = new McpServer({ name: "test-server", version: "0.0.0" });
  instrumentToolCalls(server, telemetry);
  server.registerTool("leaky", { description: "leaky", inputSchema: { secret: z.string() } }, async ({ secret }) =>
    errorResult(`HTTP 403 нет доступа к кабинету ${secret} (user@example.com)`),
  );
  server.registerTool("boom", { description: "boom", inputSchema: {} }, async () => {
    throw new Error("HTTP 401 token for user@example.com expired");
  });
  const mcp = new Client({ name: "test-client", version: "9.9.9" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);

  const res = await mcp.callTool({ name: "leaky", arguments: { secret: "hunter2" } });
  assert.equal((res as { isError?: boolean }).isError, true, "the result itself is untouched");
  await mcp.callTool({ name: "boom", arguments: {} });

  const calls = sent.filter((s) => s.body.event === "tool_call");
  assert.deepEqual(
    calls.map((c) => [c.body.tool, c.body.reason]),
    [
      ["leaky", "error_permission"],
      ["boom", "error_auth"],
    ],
  );
  const wire = JSON.stringify(calls.map((c) => c.body));
  for (const leak of ["hunter2", "user@example.com", "кабинет", "expired"]) {
    assert.ok(!wire.includes(leak), `${leak} must never reach telemetry`);
  }
});

test("a successful call reports ok", async () => {
  const sent: Sent[] = [];
  const mcp = await connectedPair(new Telemetry("1.0.0", true, recordingFetch(sent)));
  await mcp.callTool({ name: "echo", arguments: { secret: "x" } });
  assert.equal(sent.find((s) => s.body.event === "tool_call")?.body.reason, "ok");
});

test("a tool_call reason outside TOOL_OUTCOMES never leaves the machine", () => {
  const sent: Sent[] = [];
  const t = new Telemetry("1.0.0", true, recordingFetch(sent));
  t.send("tool_call", { tool: "x", reason: "error_user_ivanov" as never });
  t.send("tool_call", { tool: "x", reason: "error_auth" });
  assert.deepEqual(
    sent.map((s) => s.body.reason),
    [undefined, "error_auth"],
  );
});

test("toolOutcome: throw undefined is an error, not ok", () => {
  assert.equal(toolOutcome(undefined, undefined), "error_internal");
});

test("Direct's 'no access to this client' is a permission outcome, not auth", () => {
  assert.equal(
    toolOutcome(errorResult("Ошибка: [53] Ошибка авторизации: у токена нет доступа к кабинету «x» через Client-Login")),
    "error_permission",
  );
});

test("an API code at the head beats words quoted in the text", () => {
  // Real clients.get answer: the allowed values include ForbiddenPlatform.
  const text =
    "[8000] Некорректный запрос: Элемент массива FieldNames содержит неверное значение перечисления, ожидается одно из значений: AccountQuality, Archived, ClientId, ClientInfo, CountryId, CreatedAt, Currency, Grants, Bonuses, Login, Notification, OverdraftSumAvailable, Phone, Representatives, Restrictions, Settings, Type, Subtype, VatRate, ManagedLogins, ForbiddenPlatform, AvailableCampaignTypes, AvailableAdGroupTypes, ProductMode (request_id: 4573631628979678599)";
  assert.equal(toolOutcome(errorResult(`Ошибка: ${text}`)), "error_invalid_request");
  const thrown = new Error(text);
  thrown.name = "YandexDirectError";
  assert.equal(toolOutcome(undefined, thrown), "error_invalid_request");
  assert.equal(toolOutcome(errorResult('Ошибка: Ошибка Live v4 "GetBalance": [54] Нет прав, timed out')), "error_permission");
  // 53 stays with the text; a code past the head still counts through the patterns.
  assert.equal(toolOutcome(errorResult("Ошибка: [53] Ошибка авторизации: Недействительный OAuth-токен")), "error_auth");
  assert.equal(toolOutcome(errorResult(`Ошибка: ${"x".repeat(80)} отвечает [56]`)), "error_rate_limit");
});

test("telemetry never changes what the tool returns or throws", async () => {
  const sent: Sent[] = [];
  const telemetry = new Telemetry("1.0.0", true, recordingFetch(sent));
  const server = new McpServer({ name: "test-server", version: "0.0.0" });
  instrumentToolCalls(server, telemetry);
  let reads = 0;
  const hostile = {
    content: [{ type: "text" as const, text: "fine" }],
    get isError(): boolean {
      // The classifier reads first (before the result goes back to the SDK): that read blows up.
      if (++reads === 1) throw new Error("getter boom");
      return false;
    },
  };
  server.registerTool("hostile", { description: "h", inputSchema: {} }, async () => hostile as never);
  const original = new Error("tool's own error");
  Object.defineProperty(original, "name", { get: () => { throw new Error("name boom"); } });
  server.registerTool("throws", { description: "t", inputSchema: {} }, async () => {
    throw original;
  });
  const mcp = new Client({ name: "test-client", version: "9.9.9" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);

  const res = await mcp.callTool({ name: "hostile", arguments: {} });
  assert.equal((res as { content: { text: string }[] }).content[0].text, "fine");
  const thrown = await mcp.callTool({ name: "throws", arguments: {} });
  assert.match(JSON.stringify(thrown), /tool's own error/);
  assert.ok(!JSON.stringify(thrown).includes("boom"), "the classifier's failure must not replace the tool's error");
});

test("with telemetry off the result is not inspected at all", async () => {
  const telemetry = new Telemetry("1.0.0", false, recordingFetch([]));
  const server = new McpServer({ name: "test-server", version: "0.0.0" });
  instrumentToolCalls(server, telemetry);
  let reads = 0;
  server.registerTool("probe", { description: "p", inputSchema: {} }, async () => ({
    content: [{ type: "text" as const, text: "x" }],
    get isError() {
      reads++;
      return false;
    },
  }) as never);
  const mcp = new Client({ name: "test-client", version: "9.9.9" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  const before = reads;
  await mcp.callTool({ name: "probe", arguments: {} });
  assert.ok(reads - before <= 1, "only the SDK itself may read the result");
});
