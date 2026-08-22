import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MysqlClient } from "../client.js";
import { analyze, assertWritable, isBounded } from "../sql.js";
import { ValidationError, type Permissions } from "../types.js";
import { describePermissions } from "../config.js";
import { ok, fail, DESTRUCTIVE, sqlParams, sqlText } from "./util.js";

/**
 * The single write tool. It is registered even when every ALLOW_* flag is off:
 * a tool that is absent looks to the model like a capability that does not
 * exist, and it will invent workarounds (writing through `query`, asking the
 * user to run SQL by hand). Present-and-refusing is the honest state — the
 * refusal names the variable that would enable it.
 */
export function registerWriteTools(server: McpServer, client: MysqlClient, permissions: Permissions): void {
  const allowed = describePermissions(permissions);

  server.registerTool(
    "execute",
    {
      title: "Выполнить изменяющий SQL-запрос",
      description:
        `Выполняет один изменяющий запрос — INSERT, UPDATE, DELETE или REPLACE — и возвращает число ` +
        `затронутых строк. Сейчас сервер разрешает: ${allowed}. Права выдаются переменными ` +
        "ALLOW_INSERT_OPERATION, ALLOW_UPDATE_OPERATION и ALLOW_DELETE_OPERATION в конфигурации " +
        "MCP-клиента и требуют перезапуска сервера — из диалога их получить нельзя. DDL " +
        "(CREATE, ALTER, DROP, TRUNCATE) не поддерживается ни при каких настройках. Запрос выполняется " +
        "сразу и без транзакции: откатить его отсюда нельзя. UPDATE и DELETE без WHERE и LIMIT " +
        "требуют явного allow_full_table=true.",
      annotations: DESTRUCTIVE,
      inputSchema: {
        sql: sqlText(),
        params: sqlParams().optional(),
        allow_full_table: z
          .boolean()
          .optional()
          .describe(
            "Подтверждение для UPDATE или DELETE без WHERE и LIMIT — такой запрос затрагивает всю таблицу.",
          ),
      },
    },
    async ({ sql, params, allow_full_table }) => {
      try {
        const analysis = analyze(sql);
        assertWritable(analysis, permissions);

        // The classic catastrophic typo is a WHERE that never got typed. The
        // statement is legal and the permission is real, so nothing below would
        // stop it — only an explicit second signal from the caller does.
        if ((analysis.kind === "update" || analysis.kind === "delete") && !isBounded(analysis)) {
          if (allow_full_table !== true) {
            throw new ValidationError(
              `${analysis.verb} без WHERE и LIMIT затронет все строки таблицы. ` +
                "Если это действительно нужно, повторите вызов с allow_full_table=true; " +
                "иначе добавьте условие. Откатить операцию отсюда будет нельзя.",
            );
          }
        }

        const result = await client.write(analysis.statement, params ?? []);
        return ok({
          ...result,
          statement: analysis.verb,
          // affectedRows counts matched rows for UPDATE, changedRows only those
          // whose values differ — "0 changed of 5 affected" is a successful
          // no-op, not a failure, and the difference is worth naming.
          ...(analysis.kind === "update" && result.changedRows !== undefined
            ? {
                note:
                  `Совпало строк: ${result.affectedRows}, реально изменено: ${result.changedRows}. ` +
                  "Разница означает, что часть строк уже содержала эти значения.",
              }
            : {}),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );
}
