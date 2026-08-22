# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-08-21

### Added

- MCP server for one MySQL/MariaDB database over stdio, bound to `MYSQL_DB`.
- Six tools: `server_info`, `list_tables`, `describe_table`, `query`, `explain`, `execute`.
- Statement classification in `src/sql.ts`: the server decides what a statement does by parsing
  it, so `query` refuses writes and `execute` refuses reads regardless of which tool was called.
  Handles string literals, quoted identifiers, comments, CTEs fronting a write, `EXPLAIN ANALYZE`,
  `SELECT ... INTO OUTFILE` and multi-statement payloads; refuses `/*! … */` outright.
- Read path wrapped in `START TRANSACTION READ ONLY` (`MYSQL_READ_ONLY_TX`), so the server refuses
  a write even if the classifier is fooled.
- Write permissions per operation via `ALLOW_INSERT_OPERATION`, `ALLOW_UPDATE_OPERATION`,
  `ALLOW_DELETE_OPERATION`; DDL unavailable under any configuration; `UPDATE`/`DELETE` without
  `WHERE` require `allow_full_table: true`.
- Row cap enforced by stopping the result stream (`MYSQL_MAX_ROWS`), with an explicit `truncated`
  flag and a sentence saying the result is a prefix.
- Statement timeout that destroys the connection (`MYSQL_TIMEOUT_MS`), plus server-side
  `max_execution_time` / `max_statement_time` where supported.
- Asymmetric retries: reads repeat on dropped connections, writes only on deadlocks.
- TLS support (`MYSQL_SSL`, `MYSQL_SSL_CA`, `MYSQL_SSL_REJECT_UNAUTHORIZED`) and a password file
  (`MYSQL_PASS_FILE`) so the secret need not sit in the MCP client config.
- Degraded start: missing or malformed configuration never exits the process — the server
  completes the handshake and every tool call answers with the variable to fix.
- MySQL error map turning 1045 / 1044 / 1142 / 3159 / `ECONNREFUSED` and friends into the actual fix.
- Anonymous usage telemetry (opt-out `ASKADS_TELEMETRY=0`) that never sees SQL, data or names.

[1.0.0]: https://github.com/gistrec/mcp-mysql-client/releases/tag/v1.0.0
