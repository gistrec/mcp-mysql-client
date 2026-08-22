import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { MysqlError, PermissionError } from "../types.js";

/**
 * Everything below is a FACTORY (not a shared const): reusing one zod object
 * across two fields makes zod-to-json-schema dedupe them into a `$ref` (e.g.
 * params → #/properties/sql), which some tool-schema consumers (OpenAI Apps
 * review) don't dereference and flag as `any`. A fresh object per field keeps
 * each one inlined with its own type, pattern and description.
 */

/** One SQL statement. Multi-statement payloads are rejected by sql.ts. */
export const sqlText = () =>
  z
    .string()
    .min(1)
    .describe("Один SQL-запрос. Несколько инструкций через ; не выполняются.");

/**
 * Values for `?` placeholders. Always prefer these over string concatenation:
 * the driver escapes them, so a value containing a quote is data, not syntax.
 */
export const sqlParams = () =>
  z
    .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .describe("Значения для подстановки вместо ? в порядке появления.");

/** A table name in the bound database. */
export const tableName = () =>
  z.string().min(1).max(64).describe("Имя таблицы в подключённой базе данных.");

/** Per-call row cap; the configured MYSQL_MAX_ROWS still applies as the ceiling. */
export const rowLimit = () =>
  z
    .number()
    .int()
    .min(1)
    .max(10_000)
    .describe("Максимум строк в ответе. Потолок задан MYSQL_MAX_ROWS и не повышается этим полем.");

/**
 * Wraps a value as a compact-JSON tool result (compact: the consumer is an
 * LLM, and pretty-printing a result set burns tokens for nothing).
 */
export function ok(data: unknown): CallToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  return { content: [{ type: "text", text: text ?? "null" }] };
}

/**
 * Renders an error for the agent, with the fix attached when the failure has a
 * known one. MySQL's access errors are the reason this exists: 1045, 1044 and
 * 1142 all read as "access denied" and mean three different things — the
 * password, the grant on the database, the grant on the table.
 */
export function fail(err: unknown): CallToolResult {
  let message = err instanceof Error ? err.message : String(err);
  // Surface the underlying cause (e.g. the socket error behind a pool failure)
  // — no secrets live in cause, and it makes failures far easier to diagnose.
  if (err instanceof Error && err.cause instanceof Error) message += ` (${err.cause.message})`;
  if (err instanceof MysqlError) {
    const hint = mysqlHint(err);
    if (hint) message += ` — ${hint}`;
    if (err.errno !== undefined) message += ` [errno ${err.errno}]`;
  }
  return { content: [{ type: "text", text: `Ошибка: ${message}` }], isError: true };
}

/**
 * What MySQL's failures actually mean for this server's configuration.
 *
 * Server errnos and driver codes are kept apart on purpose: an errno comes
 * from a database that answered (so the connection is fine and the problem is
 * a grant, a name or a lock), while a driver code means the connection itself
 * never worked (host, port, TLS) — and confusing the two sends the operator
 * editing the wrong variable.
 */
function mysqlHint(err: MysqlError): string | undefined {
  switch (err.errno) {
    case 1045:
      return "сервер отверг пару логин/пароль: проверьте MYSQL_USER и MYSQL_PASS (или MYSQL_PASS_FILE)";
    case 1044:
      return "пользователь есть, но у него нет прав на эту базу: нужен GRANT на базу из MYSQL_DB";
    case 1049:
      return "базы с таким именем нет на сервере: проверьте MYSQL_DB";
    case 1142:
    case 1143:
      return (
        "пользователю не хватает права именно на эту операцию или таблицу — это ограничение GRANT в самой MySQL, " +
        "переменные ALLOW_*_OPERATION его не расширяют"
      );
    case 1146:
      return "такой таблицы нет в подключённой базе: посмотрите список через list_tables";
    case 1054:
      return "такого столбца нет: посмотрите структуру через describe_table";
    case 1064:
      return "синтаксическая ошибка в SQL";
    case 1205:
      return "строку держит чужая транзакция: повторите позже или сузьте выборку";
    case 1213:
      return "взаимная блокировка транзакций; сервер уже повторил запрос, но безуспешно";
    case 1040:
      return "на сервере закончились свободные соединения: уменьшите MYSQL_POOL_SIZE";
    case 1226:
      return "для пользователя исчерпан лимит ресурсов, заданный в GRANT ... WITH MAX_*";
    case 1317:
      return (
        "запрос прерван сервером: обычно это серверный лимит времени (max_execution_time или init_connect) " +
        "либо KILL — сузьте выборку"
      );
    case 3024:
      return "запрос превысил серверный лимит max_execution_time — сузьте выборку или поднимите MYSQL_TIMEOUT_MS";
    case 1792:
      return (
        "попытка записи внутри read-only транзакции: изменяющие запросы выполняет инструмент execute " +
        "при включённых ALLOW_*_OPERATION"
      );
    case 3159:
      return "сервер принимает только TLS-соединения: задайте MYSQL_SSL=true (и при своём CA — MYSQL_SSL_CA)";
    case 1698:
      return "пользователь аутентифицируется через сокет (auth_socket), пароль ему не подходит";
    default:
      break;
  }
  switch (err.code) {
    case "ECONNREFUSED":
      return "по этому адресу никто не слушает: проверьте MYSQL_HOST, MYSQL_PORT и что сервер запущен";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "имя хоста не разрешается в адрес: проверьте MYSQL_HOST";
    case "ETIMEDOUT":
      return "соединение не установилось за отведённое время: обычно это файрвол или неподнятый VPN до базы";
    case "ECONNRESET":
    case "EPIPE":
    case "PROTOCOL_CONNECTION_LOST":
      return "соединение с базой оборвалось на полпути — если база за VPN или туннелем, проверьте канал";
    case "HANDSHAKE_NO_SSL_SUPPORT":
      return "сервер не умеет TLS, а сервер запущен с MYSQL_SSL=true — снимите флаг либо включите TLS на сервере";
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
      return "сертификат сервера не проверяется системными CA: укажите MYSQL_SSL_CA с нужным корневым сертификатом";
    case "ER_NOT_SUPPORTED_AUTH_MODE":
      return "сервер требует современный способ аутентификации поверх TLS: включите MYSQL_SSL=true";
    default:
      return undefined;
  }
}

/** True when the failure is a refusal by policy rather than a database error. */
export function isPermissionError(err: unknown): err is PermissionError {
  return err instanceof PermissionError;
}

/**
 * MCP tool annotations — hints the consuming client can use to gate or label a
 * tool. All four hints are always set explicitly: some clients (OpenAI Apps
 * review) require readOnlyHint, destructiveHint and openWorldHint on every tool.
 */

/** Reads and changes nothing. Every tool here but `execute`. */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/**
 * `execute` carries arbitrary DML: the same call can insert a row or delete a
 * table's worth of them, and neither is undoable from here. It is marked
 * destructive and non-idempotent regardless of which ALLOW_* flags are on, so a
 * host that gates destructive tools gates this one even in an insert-only
 * install.
 */
export const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;
