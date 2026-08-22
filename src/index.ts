#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MysqlClient } from "./client.js";
import {
  ConfigError,
  DEFAULT_MAX_ROWS,
  DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS,
  describePermissions,
  describeTarget,
  hasCredentials,
  loadConfig,
  missingCredentials,
} from "./config.js";
import { instrumentToolCalls, Telemetry } from "./telemetry.js";
import type { MysqlConfig } from "./types.js";
import { registerQueryTools } from "./tools/query.js";
import { registerSchemaTools } from "./tools/schema.js";
import { registerServerTools } from "./tools/server.js";
import { registerWriteTools } from "./tools/write.js";

/**
 * Prose handed to the calling model in the `initialize` result, before it picks
 * a tool. It carries only what the tool list cannot: that the server is bound
 * to one database, which writes are enabled *in this install*, and the three
 * facts that otherwise get discovered by failing — a truncated result is a
 * prefix, permissions cannot be widened from the chat, and MySQL's own grants
 * are a separate wall behind the server's. It is prepended to every session's
 * context, so it stays short.
 */
function instructionsFor(config: MysqlConfig): string {
  return (
    `MySQL: сервер подключён к одной базе данных (${config.database}), сменить её из диалога нельзя. ` +
    "Читающие запросы выполняет query, план — explain, структуру дают list_tables и describe_table, " +
    "сведения о подключении и правах — server_info. Тип запроса определяет сам сервер, разбирая SQL: " +
    "изменяющий запрос в query будет отклонён, даже если права на запись включены. " +
    `Разрешено сейчас: ${describePermissions(config.permissions)}; ` +
    "DDL (CREATE, ALTER, DROP, TRUNCATE) недоступен всегда. Расширить права из диалога невозможно — " +
    "они задаются переменными ALLOW_*_OPERATION в конфигурации MCP-клиента и читаются при старте. " +
    "Права самой MySQL — отдельное ограничение поверх этого: отказ с errno 1142 снимается только GRANT. " +
    `Ответ ограничен ${config.maxRows} строками: если в результате truncated=true, это префикс, а не весь ` +
    "набор — уточняйте запрос или считайте агрегатами, а не подставляйте усечённые данные в выводы. " +
    `Запрос прерывается через ${config.timeoutMs} мс. Значения передавайте через ? и params: подстановка ` +
    "выполняется драйвером и не ломается на кавычках. Запись выполняется сразу и без транзакции — " +
    "откатить её отсюда нельзя, поэтому перед UPDATE и DELETE стоит проверить выборку через query."
  );
}

/**
 * Prepended to the instructions when the connection is not configured. The
 * model reads this before it picks a tool, so an unconfigured session opens
 * with the fix rather than with a failed call. There is no in-chat login:
 * credentials come only from the environment.
 */
function unconfiguredPrefix(config: MysqlConfig, problem?: ConfigError): string {
  const missing = missingCredentials(config).join(", ");
  return (
    `ВНИМАНИЕ: подключение к MySQL не настроено — не заданы ${missing}, поэтому любой вызов инструмента ` +
    "вернёт ошибку. Подключиться из диалога нельзя: оператор должен задать переменные окружения в " +
    "конфигурации MCP-клиента — MYSQL_HOST (или MYSQL_SOCKET_PATH), MYSQL_PORT, MYSQL_USER, MYSQL_PASS, " +
    "MYSQL_DB, при необходимости MYSQL_SSL=true и MYSQL_SSL_CA — и перезапустить сервер: переменные " +
    "читаются только при старте. " +
    (problem ? `Проблема конфигурации: ${problem.message} ` : "")
  );
}

/** Reads the package version so the server reports its real version to MCP clients. */
function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Loads the config without dying on a bad value. A server that exits here never
 * completes the MCP handshake, so the user sees a dead server and no reason —
 * instead the problem is carried into the session, where the model can read it
 * and relay it. (Missing credentials are not an error at all — loadConfig
 * leaves the fields undefined; a *malformed* value throws ConfigError, caught
 * here: the config degrades to "no credentials" and every tool call answers
 * with CredentialsError.)
 */
function loadConfigOrDegraded(telemetry: Telemetry): { config: MysqlConfig; problem?: ConfigError } {
  try {
    return { config: loadConfig() };
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(`Ошибка конфигурации: ${err.message}`);
    // Fire-and-forget now that the process survives: the `startup_failed`
    // funnel stays comparable across the server line, but nothing blocks startup.
    telemetry.send("startup_failed", { reason: err.reason });
    return {
      // No host and no user on purpose: with one value malformed there is
      // nothing left to trust, and no connection is attempted anyway.
      config: {
        port: DEFAULT_PORT,
        permissions: { insert: false, update: false, delete: false },
        maxRows: DEFAULT_MAX_ROWS,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        connectTimeoutMs: 10_000,
        poolSize: 1,
        maxRetries: 0,
        readOnlyTransactions: true,
        configProblem: err.message,
      },
      problem: err,
    };
  }
}

async function main(): Promise<void> {
  // Anonymous usage pings (ids/names/versions only, never SQL, data or
  // arguments); opt out with ASKADS_TELEMETRY=0. Built before the config so a
  // malformed value can be reported; wired to the server before tools register.
  const version = readVersion();
  const telemetry = new Telemetry(version);
  const { config, problem } = loadConfigOrDegraded(telemetry);
  const client = new MysqlClient(config);

  // Credentials come only from the environment, so this cannot change
  // mid-session: an unconfigured start stays unconfigured until the operator
  // sets the variables and restarts the server.
  const connected = hasCredentials(config);

  const server = new McpServer(
    { name: "mcp-mysql-client", version },
    // `instructions` rides in the initialize result, so the model reads it once
    // per session before any tool call — the only prose it is guaranteed to see.
    {
      instructions: connected
        ? instructionsFor(config)
        : unconfiguredPrefix(config, problem) + instructionsFor(config),
    },
  );

  instrumentToolCalls(server, telemetry);
  server.server.oninitialized = () => {
    telemetry.setClientInfo(server.server.getClientVersion());
    // Split on purpose: `server_start` keeps meaning "a usable install started",
    // so the unconfigured case gets its own event instead of inflating that number.
    if (connected) telemetry.send("server_start");
    else {
      telemetry.send("unconfigured_start", {
        reason: problem?.reason ?? `missing_${(missingCredentials(config)[0] ?? "credentials").toLowerCase()}`,
      });
    }
  };

  registerServerTools(server, client, config);
  registerSchemaTools(server, client);
  registerQueryTools(server, client);
  registerWriteTools(server, client, config.permissions);

  // The pool holds open sockets and would keep the process alive after the host
  // closes stdio; MCP hosts kill servers by signal, so both paths are covered.
  const shutdown = () => {
    void client.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    connected
      ? // describeTarget, never the raw config: this line lands in the host's
        // log file, and the password must not travel with it.
        `mcp-mysql-client работает через stdio (${describeTarget(config)}, ${describePermissions(config.permissions)})`
      : "mcp-mysql-client работает через stdio (подключение не настроено — задайте MYSQL_HOST, MYSQL_USER " +
          "и MYSQL_DB и перезапустите сервер)",
  );
}

main().catch((err) => {
  console.error("Критическая ошибка запуска mcp-mysql-client:", err);
  process.exit(1);
});
