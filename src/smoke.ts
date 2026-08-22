#!/usr/bin/env node
/**
 * Live READ-ONLY smoke check against the configured database.
 *
 * Nothing here writes: it identifies the server, lists the tables, describes
 * the first one and runs a trivial SELECT. Every statement goes through the
 * same client the tools use, so a pass proves the whole path — TLS, auth, the
 * read-only transaction, the row cap and the timeout — not just connectivity.
 * Run it with your own credentials in the environment.
 */
import { MysqlClient } from "./client.js";
import { ConfigError, describePermissions, describeTarget, hasCredentials, loadConfig } from "./config.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Конфигурация непригодна: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  if (!hasCredentials(config)) {
    console.error(
      "Не заданы переменные подключения. Минимум: MYSQL_HOST, MYSQL_USER, MYSQL_PASS, MYSQL_DB.",
    );
    process.exit(1);
  }

  console.log(`Цель: ${describeTarget(config)} (${describePermissions(config.permissions)})`);
  const client = new MysqlClient(config);

  try {
    const info = await client.serverInfo();
    const row = info.rows[0] as Record<string, unknown>;
    console.log(`Сервер: ${row.server_version}, база: ${row.current_database}, пользователь: ${row.effective_user}`);

    const size = await client.databaseSize();
    const sizeRow = size.rows[0] as Record<string, unknown>;
    console.log(`Таблиц: ${sizeRow.tables}, данных: ${sizeRow.data_bytes} Б, индексов: ${sizeRow.index_bytes} Б`);

    const tables = await client.listTables();
    console.log(`list_tables вернул ${tables.rowCount} строк за ${tables.durationMs} мс`);

    const first = tables.rows[0] as { name?: string } | undefined;
    if (first?.name) {
      const columns = await client.tableColumns(first.name);
      console.log(`describe_table(${first.name}): ${columns.rowCount} столбцов`);
    } else {
      console.log("В базе нет таблиц — проверка структуры пропущена");
    }

    // The read path end to end, including the read-only transaction.
    const probe = await client.read("SELECT 1 AS ok");
    console.log(`SELECT 1 → ${JSON.stringify(probe.rows)} за ${probe.durationMs} мс`);

    const grants = await client.grants().catch(() => null);
    console.log(grants ? `Права: ${grants.join(" | ")}` : "Права: SHOW GRANTS недоступен под этим пользователем");

    console.log("Проверка пройдена: подключение и чтение работают, ничего не изменено.");
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(`Проверка не пройдена: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
