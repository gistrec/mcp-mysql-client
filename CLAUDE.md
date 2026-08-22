# CLAUDE.md — mcp-mysql-client

MCP server for **one MySQL/MariaDB database**, TypeScript over stdio. No HTTP API and no OAuth:
the transport is a `mysql2` connection pool built from `MYSQL_*` environment variables, and the
whole product is what happens *between* the model's SQL and that pool.

The threat model is the point of this repo. The caller is a language model with a prompt-shaped
attack surface, pointed at a database that may be production. So: the server classifies every
statement itself (`sql.ts`) instead of trusting which tool the model picked, reads run inside
`START TRANSACTION READ ONLY` so the *server* refuses a write that got past the classifier, and
write permissions live only in the environment where the model cannot reach them.

## Commands

```bash
npm run dev        # run from source (tsx watch)
npm test           # unit tests + a dist smoke probe, no database
npm run typecheck  # types for src + tests
npm run build      # emit dist/
npm run smoke      # live READ-ONLY check (needs MYSQL_* in the environment)
```

## Architecture

- `src/config.ts` — env → config. Missing `MYSQL_USER` / `MYSQL_DB` (empty string = absent) is NOT
  an error: the fields stay `undefined`, the server starts degraded and the client raises
  `CredentialsError` at call time. `ConfigError` (with a `reason` code) is reserved for malformed
  values — `invalid_port`, `unreadable_ssl_ca`, `unreadable_pass_file` — and is caught by
  `loadConfigOrDegraded` in `index.ts`. `boolean()` never opens a write permission on an
  unparseable value. `describeTarget` is the only printable form of the target (stderr is captured
  to disk by MCP hosts, so the password must never reach it).
- `src/types.ts` — config, `QueryResult` (`{rows, rowCount, truncated, columns, durationMs}`),
  `WriteResult`, `Permissions`, and the error vocabulary: `CredentialsError`, `ValidationError`,
  `PermissionError` (with `kind`), `TimeoutError`, `MysqlError` (keeps `code`/`errno`/`sqlState`).
- `src/sql.ts` — the statement gate. `scan()` is a lexical scanner tracking strings, backtick
  identifiers and comments, splitting on top-level `;`. `analyze()` classifies into
  read / insert / update / delete / replace / ddl / forbidden. `assertReadable` and
  `assertWritable` are the two gates the tools call. Deliberately conservative, not a grammar.
- `src/client.ts` — the pool and the two paths. `read()` streams rows and stops at the cap
  (a cut-short stream leaves the connection unusable, so it is destroyed, not released),
  `write()` runs in autocommit. Plus the `information_schema` queries behind the schema tools,
  all scoped to the bound database.
- `src/tools/*.ts` — `server` (server_info), `schema` (list_tables, describe_table), `query`
  (query, explain), `write` (execute); each exports one `register*Tools`. `tools/util.ts` —
  `ok`/`fail`, the MySQL error→fix map, the annotation presets and the shared zod schema
  **factories**. `tools/harness.ts` — the fake server/client pair the tool tests share.
- `src/index.ts` — wires every `register*` into the McpServer, builds the session `instructions`
  from the live config (bound database, current permissions, row cap, timeout), and closes the
  pool on SIGINT/SIGTERM.
- `src/telemetry.ts` — anonymous usage pings (ids/names/versions only; never SQL, table names,
  row data, the host or the database name). Opt-out `ASKADS_TELEMETRY=0`.

## Conventions (do not break)

- **The server classifies the SQL; the tool choice is a hint, not a fact.** `query` refuses a
  `DELETE` even with `ALLOW_DELETE_OPERATION=true`, and `execute` refuses a `SELECT`. A model that
  picks the wrong tool must be corrected, not obeyed. Pinned in `sql.test.ts` and
  `tools/*.test.ts`.
- **Refuse before connecting.** Classification, permission checks and the full-table confirmation
  all run before a connection is taken, so a refusal costs nothing and cannot be confused with a
  connection failure. `test/dist-smoke.test.js` asserts this by refusing statements on a server
  with no credentials at all.
- **Run the statement that was checked.** Tools pass `analysis.statement` (comments stripped,
  trailing `;` removed) to the client, never the raw input — otherwise the checked text and the
  executed text are two different strings.
- **`/*! ... */` is refused, not stripped.** MySQL executes version-gated comments, so treating
  them as comments would hide the real statement from every check above.
- **Defence in depth, three layers.** The classifier, then `START TRANSACTION READ ONLY` on the
  read path (`MYSQL_READ_ONLY_TX`), then the MySQL user's own grants. Never weaken one because
  another exists; `errno 1792` in the read path means layer 1 failed and must be fixed.
- **DDL is never available.** Not behind a flag, not behind a confirmation. Schema changes are
  migrations, and an agent that can `DROP` is a different product.
- **Permissions come only from the environment.** No tool grants anything; refusals name the
  variable and say a restart is required. `execute` stays registered even when everything is off —
  a missing tool reads as a missing capability and the model invents workarounds.
- **Never exit because of configuration.** A server that dies before the MCP handshake leaves the
  user with a red cross and no reason. Missing credentials are a survivable state: start, answer
  `initialize` (with the unconfigured prefix in `instructions`) and `tools/list`, and let every
  tool call fail with `CredentialsError` naming the variables. A malformed value degrades the same
  way via `ConfigError`.
- **Truncation is stated, never implied.** A capped read returns `truncated: true` *and* a
  sentence saying the result is a prefix — a model summarizing silently truncated rows draws
  confident wrong conclusions about the whole table.
- **The row cap is enforced by stopping the stream.** Buffering a million rows and slicing is not
  a cap; it is an OOM with a nice API.
- **A timeout destroys the connection.** A promise race would leave the statement running on the
  server and the connection poisoned in the pool.
- **Retries are asymmetric.** Reads repeat on dropped connections (the statement never ran);
  writes repeat only on deadlocks (the transaction was rolled back whole). A repeated INSERT after
  a lost connection could double a row.
- **Errors name the fix.** MySQL's 1045 / 1044 / 1142 all read as "access denied" and mean the
  password, the grant on the database and the grant on the table. The map in `tools/util.ts` keeps
  server errnos and driver codes apart on purpose: an errno means the database answered and the
  connection is fine.
- **Validate inputs with zod** in `inputSchema`, reusing the schema **factories** in `util.ts` (a
  fresh schema per field avoids `$ref` dedup in the generated JSON schema). zod stays on **v3**
  (`^3.25.0`).
- **Output compact JSON via `ok`** — the consumer is an LLM; pretty-printing a result set burns
  tokens. Buffers become base64 with a byte count, never `{"type":"Buffer","data":[…]}`.
- **Annotations:** `READ_ONLY` for everything but `execute`, which is `DESTRUCTIVE` regardless of
  which ALLOW_* flags are on — a host that gates destructive tools must gate it even in an
  insert-only install.

## Adding a tool

1. Add (or extend) `src/tools/<name>.ts` with `register<Name>Tools(server, client, …)`.
2. If it needs a new query, add a method to `src/client.ts` (schema queries are parameterized on
   the bound database and never take a schema name from an argument).
3. Import and call the register fn in `src/index.ts`.
4. Add it to `EXPECTED` in `test/dist-smoke.test.js` and document it in `docs/TOOLS.md`.
