import assert from "node:assert/strict";
import test from "node:test";
import { registerSchemaTools } from "./schema.js";
import { harness, rows, textOf } from "./harness.js";

const COLUMNS = [
  { name: "id", type: "int unsigned", nullable: "NO", key_type: "PRI" },
  { name: "email", type: "varchar(255)", nullable: "YES", key_type: "UNI" },
];

/** Two rows of one composite index plus a single-column one, as information_schema returns them. */
const INDEX_ROWS = [
  { name: "PRIMARY", non_unique: 0, seq: 1, column_name: "id", index_type: "BTREE", nullable: "", cardinality: 100, prefix_length: null },
  { name: "idx_pair", non_unique: 1, seq: 1, column_name: "a", index_type: "BTREE", nullable: "YES", cardinality: 50, prefix_length: null },
  { name: "idx_pair", non_unique: 1, seq: 2, column_name: "b", index_type: "BTREE", nullable: "YES", cardinality: 50, prefix_length: 10 },
];

const METHODS = {
  listTables: rows([{ name: "users", type: "BASE TABLE", engine: "InnoDB" }]),
  tableColumns: rows(COLUMNS),
  tableIndexes: rows(INDEX_ROWS),
  tableForeignKeys: rows([{ name: "fk_order_user", column_name: "user_id", references_table: "users" }]),
  tableReferencedBy: rows([{ from_table: "orders", from_column: "user_id" }]),
};

test("registers both schema tools as read-only", () => {
  const { configs } = harness(registerSchemaTools, METHODS);
  assert.deepEqual(Object.keys(configs).sort(), ["describe_table", "list_tables"]);
  for (const config of Object.values(configs)) {
    assert.equal(config.annotations?.readOnlyHint, true);
  }
});

test("list_tables returns the tables with a count", async () => {
  const { tools } = harness(registerSchemaTools, METHODS);
  const text = textOf(await tools.list_tables!({}));
  assert.match(text, /users/);
  assert.match(text, /"count":1/);
});

test("describe_table assembles columns, indexes and both foreign-key directions", async () => {
  const { tools, calls } = harness(registerSchemaTools, METHODS);
  const result = JSON.parse(textOf(await tools.describe_table!({ table: "users" })));

  assert.equal(result.table, "users");
  assert.equal(result.columns.length, 2);
  assert.ok(result.foreign_keys);
  // The direction that decides whether a DELETE is safe.
  assert.ok(result.referenced_by);
  assert.equal(calls.every((call) => call.params[0] === "users"), true);
});

test("index rows are grouped into indexes, keeping column order", async () => {
  const { tools } = harness(registerSchemaTools, METHODS);
  const result = JSON.parse(textOf(await tools.describe_table!({ table: "users" })));

  assert.equal(result.indexes.length, 2);
  const primary = result.indexes.find((index: { name: string }) => index.name === "PRIMARY");
  assert.equal(primary.unique, true);

  const composite = result.indexes.find((index: { name: string }) => index.name === "idx_pair");
  assert.equal(composite.unique, false);
  // Column order is the whole point of a composite index.
  assert.deepEqual(composite.columns.map((c: { name: string }) => c.name), ["a", "b"]);
  assert.equal(composite.columns[1].prefix_length, 10);
});

test("sections can be turned off, and then they are not queried at all", async () => {
  const { tools, calls } = harness(registerSchemaTools, METHODS);
  const result = JSON.parse(
    textOf(await tools.describe_table!({ table: "users", include_indexes: false, include_foreign_keys: false })),
  );

  assert.ok(result.columns);
  assert.equal(result.indexes, undefined);
  assert.equal(result.foreign_keys, undefined);
  assert.deepEqual(calls.map((call) => call.method), ["tableColumns"]);
});

test("an unknown table is an explicit error, not an empty column list", async () => {
  // information_schema answers an unknown table with an empty set; without the
  // check the caller sees "no columns" and no reason.
  const { tools } = harness(registerSchemaTools, { ...METHODS, tableColumns: rows([]) });
  const result = await tools.describe_table!({ table: "ghosts" });

  assert.equal(result.isError, true);
  assert.match(textOf(result), /нет таблицы «ghosts»/);
  assert.match(textOf(result), /list_tables/);
});
