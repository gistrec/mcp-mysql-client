import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MysqlClient } from "../client.js";
import type { MysqlConfig } from "../types.js";
import { ok, fail, READ_ONLY } from "./util.js";

/**
 * One tool that answers "what am I connected to and what may I do here?".
 *
 * Both halves matter and neither can be derived from the other: ALLOW_* is what
 * this server permits, GRANTs are what MySQL permits, and a write needs both.
 * Without this the model discovers the boundary by running into it.
 */
export function registerServerTools(server: McpServer, client: MysqlClient, config: MysqlConfig): void {
  server.registerTool(
    "server_info",
    {
      title: "Сведения о подключении и правах",
      description:
        "Показывает, к какой базе и под каким пользователем подключён сервер, версию MySQL, размер базы, " +
        "выданные пользователю права (GRANT) и действующие ограничения самого MCP-сервера: разрешённые " +
        "операции записи, потолок строк в ответе и таймаут запроса. Стоит вызвать первым, если непонятно, " +
        "почему запрос отклонён: права MySQL и разрешения сервера — это два независимых ограничения.",
      annotations: READ_ONLY,
      inputSchema: {},
    },
    async () => {
      try {
        const [info, size] = await Promise.all([client.serverInfo(), client.databaseSize()]);
        // SHOW GRANTS is itself a privileged statement on some managed setups;
        // its absence is a fact about the account, not a failure of the call.
        const grants = await client.grants().catch(() => null);

        return ok({
          connection: {
            ...(info.rows[0] as Record<string, unknown>),
            host: config.socketPath ?? `${config.host}:${config.port}`,
            tls: config.ssl ? { enabled: true, verify_certificate: config.ssl.rejectUnauthorized } : { enabled: false },
          },
          database_size: size.rows[0],
          grants: grants ?? "SHOW GRANTS недоступен под этим пользователем",
          server_limits: {
            allowed_writes: {
              insert: config.permissions.insert,
              update: config.permissions.update,
              delete: config.permissions.delete,
            },
            ddl: false,
            max_rows_per_read: config.maxRows,
            statement_timeout_ms: config.timeoutMs,
            read_only_transactions: config.readOnlyTransactions,
          },
        });
      } catch (err) {
        return fail(err);
      }
    },
  );
}
