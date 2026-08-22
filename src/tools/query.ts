import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MysqlClient } from "../client.js";
import { analyze, assertReadable } from "../sql.js";
import { ok, fail, READ_ONLY, rowLimit, sqlParams, sqlText } from "./util.js";

/** EXPLAIN output formats. ANALYZE picks its own, so the two never combine. */
const FORMATS = ["traditional", "json", "tree"] as const;

/**
 * The read tools. Both classify the SQL first and run the *normalized*
 * statement the classifier approved — not the original string — so what
 * executes is exactly what was checked, with comments already stripped.
 */
export function registerQueryTools(server: McpServer, client: MysqlClient): void {
  server.registerTool(
    "query",
    {
      title: "Выполнить читающий SQL-запрос",
      description:
        "Выполняет один читающий запрос (SELECT, SHOW, DESCRIBE, WITH ... SELECT) и возвращает строки. " +
        "Изменяющие запросы отклоняются даже при включённых правах на запись — для них есть execute. " +
        "Запрос идёт внутри read-only транзакции, число строк ограничено MYSQL_MAX_ROWS: если ответ " +
        "обрезан, поле truncated равно true и это префикс, а не весь результат. Значения подставляйте " +
        "через ? и params — драйвер экранирует их сам.",
      annotations: READ_ONLY,
      inputSchema: {
        sql: sqlText(),
        params: sqlParams().optional(),
        limit: rowLimit().optional(),
      },
    },
    async ({ sql, params, limit }) => {
      try {
        const analysis = analyze(sql);
        assertReadable(analysis);
        const result = await client.read(analysis.statement, params ?? [], { maxRows: limit });
        return ok({
          ...result,
          // Silence about a cut-off result reads as a complete answer, and a
          // model summarizing "the" rows would be wrong about the whole table.
          ...(result.truncated
            ? {
                note:
                  "Показаны не все строки: сработало ограничение на размер ответа. " +
                  "Уточните запрос, добавьте агрегацию или явный LIMIT со смещением.",
              }
            : {}),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "explain",
    {
      title: "Показать план выполнения запроса",
      description:
        "Возвращает план выполнения читающего запроса: какие индексы будут использованы и сколько строк " +
        "сервер рассчитывает просмотреть. Обычный режим ничего не выполняет; analyze=true запускает " +
        "запрос по-настоящему и показывает фактическое время — на больших таблицах это дорого. " +
        "Полезно перед тяжёлой выборкой и при диагностике медленных запросов.",
      annotations: READ_ONLY,
      inputSchema: {
        sql: sqlText(),
        params: sqlParams().optional(),
        format: z
          .enum(FORMATS)
          .optional()
          .describe("Формат плана: traditional — таблица, json — подробное дерево, tree — читаемое дерево."),
        analyze: z
          .boolean()
          .optional()
          .describe("Выполнить запрос и показать фактические строки и время (EXPLAIN ANALYZE)."),
      },
    },
    async ({ sql, params, format, analyze: runAnalyze }) => {
      try {
        const analysis = analyze(sql);
        assertReadable(analysis);
        // EXPLAIN ANALYZE chooses TREE itself and rejects an explicit FORMAT,
        // so the two options are mutually exclusive by construction here.
        const prefix = runAnalyze
          ? "EXPLAIN ANALYZE "
          : format && format !== "traditional"
            ? `EXPLAIN FORMAT=${format.toUpperCase()} `
            : "EXPLAIN ";
        const result = await client.read(prefix + analysis.statement, params ?? []);
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );
}
