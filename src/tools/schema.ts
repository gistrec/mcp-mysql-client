import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MysqlClient } from "../client.js";
import { ValidationError } from "../types.js";
import { ok, fail, READ_ONLY, tableName } from "./util.js";

/** One index, assembled from the per-column rows information_schema returns. */
interface IndexInfo {
  name: string;
  unique: boolean;
  type: string;
  columns: { name: string; prefix_length?: number | null; nullable: boolean }[];
  cardinality?: number | null;
}

/**
 * Schema introspection. Everything is scoped to the bound database by the
 * client's own queries, so no argument can point these at another schema.
 */
export function registerSchemaTools(server: McpServer, client: MysqlClient): void {
  server.registerTool(
    "list_tables",
    {
      title: "Список таблиц базы",
      description:
        "Перечисляет таблицы и представления подключённой базы: движок, кодировку, комментарий, размер " +
        "данных и индексов в байтах и оценку числа строк. Оценка берётся из статистики InnoDB и может " +
        "заметно расходиться с реальностью — точное число даёт COUNT(*) через query. " +
        "С этого инструмента стоит начинать знакомство с незнакомой базой.",
      annotations: READ_ONLY,
      inputSchema: {},
    },
    async () => {
      try {
        const result = await client.listTables();
        return ok({ tables: result.rows, count: result.rows.length });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "describe_table",
    {
      title: "Структура таблицы",
      description:
        "Показывает структуру таблицы: столбцы с типами, обнуляемостью, значениями по умолчанию и " +
        "комментариями, индексы с их составом, внешние ключи наружу и, главное, ссылки на эту таблицу " +
        "из других (referenced_by) — именно они определяют, безопасно ли удалять строки. " +
        "Разделы, кроме столбцов, можно отключить, если нужен только их список.",
      annotations: READ_ONLY,
      inputSchema: {
        table: tableName(),
        include_indexes: z.boolean().optional().describe("Включить индексы (по умолчанию да)."),
        include_foreign_keys: z
          .boolean()
          .optional()
          .describe("Включить внешние ключи в обе стороны (по умолчанию да)."),
      },
    },
    async ({ table, include_indexes, include_foreign_keys }) => {
      try {
        const columns = await client.tableColumns(table);
        if (columns.rows.length === 0) {
          // information_schema answers an unknown table with an empty set, not
          // an error — without this the caller gets "no columns" and no reason.
          throw new ValidationError(
            `В подключённой базе нет таблицы «${table}» (или у пользователя нет прав на неё). ` +
              "Список доступных таблиц вернёт list_tables.",
          );
        }

        const withIndexes = include_indexes !== false;
        const withForeignKeys = include_foreign_keys !== false;
        const [indexes, foreignKeys, referencedBy] = await Promise.all([
          withIndexes ? client.tableIndexes(table) : null,
          withForeignKeys ? client.tableForeignKeys(table) : null,
          withForeignKeys ? client.tableReferencedBy(table) : null,
        ]);

        return ok({
          table,
          columns: columns.rows,
          ...(indexes ? { indexes: groupIndexes(indexes.rows) } : {}),
          ...(foreignKeys ? { foreign_keys: foreignKeys.rows } : {}),
          ...(referencedBy ? { referenced_by: referencedBy.rows } : {}),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );
}

/**
 * Collapses the one-row-per-column shape of information_schema.STATISTICS into
 * one entry per index, keeping column order — which is the whole point of a
 * composite index and is lost in the flat form.
 */
function groupIndexes(rows: unknown[]): IndexInfo[] {
  const byName = new Map<string, IndexInfo>();
  for (const row of rows as Record<string, unknown>[]) {
    const name = String(row.name);
    let index = byName.get(name);
    if (!index) {
      index = {
        name,
        unique: Number(row.non_unique) === 0,
        type: String(row.index_type ?? ""),
        columns: [],
        cardinality: row.cardinality as number | null,
      };
      byName.set(name, index);
    }
    index.columns.push({
      name: String(row.column_name),
      nullable: row.nullable === "YES",
      ...(row.prefix_length !== null && row.prefix_length !== undefined
        ? { prefix_length: row.prefix_length as number }
        : {}),
    });
  }
  return [...byName.values()];
}
