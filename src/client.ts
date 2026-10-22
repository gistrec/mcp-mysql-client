/**
 * The MySQL transport: one lazily created pool, and the two paths every tool
 * ends up in — `read` (streamed, row-capped, wrapped in a read-only
 * transaction) and `write` (autocommit, no retries that could apply twice).
 *
 * Everything that makes this safe to point at a production database lives
 * here rather than in the tools: the row cap is enforced by stopping the
 * stream (not by trimming a buffer that already cost the memory), the timeout
 * destroys the connection (a promise race that leaves the query running is not
 * a timeout), and reads run inside START TRANSACTION READ ONLY so the server
 * itself refuses a write that got past the classifier in sql.ts.
 */
import { createPool, type Pool, type PoolConnection } from "mysql2/promise";
import type { Readable } from "node:stream";
import {
  CredentialsError,
  MysqlError,
  TimeoutError,
  type ColumnInfo,
  type DriverError,
  type MysqlConfig,
  type QueryResult,
  type WriteResult,
} from "./types.js";
import { hasCredentials, missingCredentials } from "./config.js";

/** Column type codes as the protocol reports them, for result-set metadata. */
const COLUMN_TYPES: Record<number, string> = {
  0: "DECIMAL",
  1: "TINYINT",
  2: "SMALLINT",
  3: "INT",
  4: "FLOAT",
  5: "DOUBLE",
  6: "NULL",
  7: "TIMESTAMP",
  8: "BIGINT",
  9: "MEDIUMINT",
  10: "DATE",
  11: "TIME",
  12: "DATETIME",
  13: "YEAR",
  15: "VARCHAR",
  16: "BIT",
  245: "JSON",
  246: "DECIMAL",
  247: "ENUM",
  248: "SET",
  249: "TINYBLOB",
  250: "MEDIUMBLOB",
  251: "LONGBLOB",
  252: "BLOB",
  253: "VARCHAR",
  254: "CHAR",
  255: "GEOMETRY",
};

/**
 * Connection-level failures worth repeating. A dropped or refused connection
 * means the statement never ran, so a read can simply be reissued — this is
 * the common case on a link that flaps (a VPN, a tunnel) rather than a real
 * database problem.
 */
const RETRYABLE_CONNECTION_CODES = new Set([
  "PROTOCOL_CONNECTION_LOST",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ER_CON_COUNT_ERROR",
]);

/** InnoDB deadlock: the transaction was rolled back whole, so a retry is safe even for writes. */
const ER_LOCK_DEADLOCK = 1213;

/** Minimal view of the callback-side connection, which is what exposes streaming. */
interface RawQuery {
  on(event: "fields", listener: (fields: { name: string; type: number }[]) => void): RawQuery;
  stream(): Readable;
}
interface RawConnection {
  query(options: { sql: string; values?: unknown[] }): RawQuery;
  stream?: { destroy(): void };
}

export interface ReadOptions {
  /** Overrides the configured cap for one call; never raises it above the config. */
  maxRows?: number;
}

export class MysqlClient {
  private pool: Pool | null = null;

  constructor(private readonly config: MysqlConfig) {}

  /**
   * Builds the pool on first use. Credentials are checked before anything else:
   * the message names the variables and says to restart, because they are read
   * only at startup and there is no login tool.
   */
  private ensurePool(): Pool {
    if (!hasCredentials(this.config)) {
      const missing = missingCredentials(this.config).join(", ");
      const problem = this.config.configProblem ? ` Проблема конфигурации: ${this.config.configProblem}` : "";
      throw new CredentialsError(
        `Подключение к MySQL не настроено: не заданы ${missing}.${problem} ` +
          "Задайте переменные окружения в конфигурации MCP-клиента и перезапустите сервер — " +
          "они читаются только при старте.",
      );
    }
    if (this.pool) return this.pool;

    const { config } = this;
    this.pool = createPool({
      ...(config.socketPath ? { socketPath: config.socketPath } : { host: config.host, port: config.port }),
      user: config.user,
      password: config.password,
      database: config.database,
      ssl: config.ssl,
      connectTimeout: config.connectTimeoutMs,
      waitForConnections: true,
      connectionLimit: config.poolSize,
      queueLimit: 0,
      // An idle pooled socket is a liability: the server drops it after
      // wait_timeout and a NAT on the way may swallow the FIN, so the next
      // statement is written into a dead socket. Idle connections are closed
      // after a minute instead; reconnecting costs a handshake, not a hang.
      // mysql2 runs its idle sweeper only while maxIdle < connectionLimit, and
      // evicts by count beyond maxIdle within a second — so maxIdle sits one
      // below the limit, and age alone decides for the rest.
      maxIdle: Math.max(0, config.poolSize - 1),
      idleTimeout: 60_000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 30_000,
      // A second line of defence behind sql.ts: even a payload that slipped
      // past the classifier cannot smuggle a second statement.
      multipleStatements: false,
      // Values arrive in shapes an LLM can read and a JSON round-trip cannot
      // corrupt: dates as the strings the column holds (no timezone guessing),
      // DECIMAL as strings (money must not become a float). BIGINT stays a
      // number while it fits in one and becomes a string only past 2^53 —
      // `bigNumberStrings: true` would quote every COUNT(*) and every id,
      // which reads as text to a model and breaks arithmetic on it.
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: false,
      timezone: "Z",
    });

    // Server-side statement timeout, so a query that outlives the client
    // timeout is also killed on the server instead of running on unattended.
    // max_execution_time is MySQL 5.7.8+ and covers SELECTs; MariaDB spells it
    // max_statement_time (seconds). Both are attempted and both may fail — the
    // client-side timeout below is the guarantee, this is the courtesy.
    const seconds = Math.max(1, Math.ceil(this.config.timeoutMs / 1000));
    this.pool.pool.on("connection", (conn) => {
      conn.query(`SET SESSION max_execution_time = ${this.config.timeoutMs}`, () => {
        conn.query(`SET SESSION max_statement_time = ${seconds}`, () => {});
      });
    });

    return this.pool;
  }

  /**
   * Runs a read: acquires a connection, opens a read-only transaction, streams
   * rows until the cap, commits and returns. The connection is destroyed rather
   * than returned to the pool whenever it may hold an unread result set or a
   * half-open transaction — a poisoned pooled connection is a far worse bug
   * than opening a fresh one.
   */
  async read(sql: string, params: unknown[] = [], options: ReadOptions = {}): Promise<QueryResult> {
    const maxRows = Math.min(options.maxRows ?? this.config.maxRows, this.config.maxRows);
    return this.withRetries(true, async () => {
      const started = Date.now();
      const conn = await this.acquire();
      let dirty = false;
      const guard = this.arm(conn);
      try {
        return await Promise.race([
          guard.expired,
          (async () => {
            if (this.config.readOnlyTransactions) await conn.query("START TRANSACTION READ ONLY");
            dirty = true;
            const { rows, truncated, columns } = await this.streamRows(conn, sql, params, maxRows);
            // A cut-short stream leaves rows unread on the wire; the connection is
            // no longer reusable, so it is dropped instead of committed.
            if (!truncated && this.config.readOnlyTransactions) await conn.query("COMMIT");
            dirty = truncated;
            return {
              rows,
              rowCount: rows.length,
              truncated,
              columns,
              durationMs: Date.now() - started,
            };
          })(),
        ]);
      } catch (err) {
        dirty = true;
        throw this.wrap(err, guard);
      } finally {
        guard.disarm();
        if (dirty) conn.destroy();
        else conn.release();
      }
    });
  }

  /**
   * Runs a write. No transaction is opened: a single autocommit statement is
   * atomic on its own, and a transaction spanning tool calls would outlive the
   * agent's attention. Only deadlocks are retried — a lost connection may have
   * applied the statement, and repeating it could double an INSERT.
   */
  async write(sql: string, params: unknown[] = []): Promise<WriteResult> {
    return this.withRetries(false, async () => {
      const started = Date.now();
      const conn = await this.acquire();
      const guard = this.arm(conn);
      let broken = false;
      try {
        const [result] = await Promise.race([guard.expired, conn.query(sql, params)]);
        const header = result as {
          affectedRows?: number;
          changedRows?: number;
          insertId?: number | string;
          warningStatus?: number;
          info?: string;
        };
        return {
          affectedRows: header.affectedRows ?? 0,
          changedRows: header.changedRows,
          // Meaningless for anything but an INSERT into an AUTO_INCREMENT table.
          insertId: header.insertId && header.insertId !== 0 ? header.insertId : undefined,
          warningCount: header.warningStatus,
          info: header.info,
          durationMs: Date.now() - started,
        };
      } catch (err) {
        broken = true;
        throw this.wrap(err, guard);
      } finally {
        guard.disarm();
        if (broken) conn.destroy();
        else conn.release();
      }
    });
  }

  /** Rows of one result set, stopping the stream once the cap is reached. */
  private async streamRows(
    conn: PoolConnection,
    sql: string,
    params: unknown[],
    maxRows: number,
  ): Promise<{ rows: unknown[]; truncated: boolean; columns?: ColumnInfo[] }> {
    const raw = (conn as unknown as { connection: RawConnection }).connection;
    const query = raw.query({ sql, values: params });
    let columns: ColumnInfo[] | undefined;
    // Column metadata is the only description of an empty result set — without
    // it "no rows" and "no such shape" look identical to the caller.
    query.on("fields", (fields) => {
      if (Array.isArray(fields)) {
        columns = fields.map((field) => ({
          name: field.name,
          type: COLUMN_TYPES[field.type] ?? `TYPE_${field.type}`,
        }));
      }
    });

    const stream = query.stream();
    const rows: unknown[] = [];
    let truncated = false;
    for await (const row of stream) {
      if (rows.length >= maxRows) {
        truncated = true;
        stream.destroy();
        break;
      }
      rows.push(normalizeRow(row));
    }
    return { rows, truncated, columns };
  }

  /** Takes a pooled connection, translating a connect failure into a MysqlError. */
  private async acquire(): Promise<PoolConnection> {
    try {
      return await this.ensurePool().getConnection();
    } catch (err) {
      throw this.wrap(err);
    }
  }

  /**
   * Client-side statement timeout. The deadline tears the socket down: MySQL
   * notices it closing and kills the statement with it. That alone does not
   * settle the call — mysql2 marks a destroyed connection as closing and then
   * never fails the command in flight — so `expired` rejects too, and the
   * caller races its work against it. `fired` tells the catch block that the
   * error it is about to see is a timeout, not a network fault.
   */
  private arm(conn: PoolConnection): { fired: boolean; expired: Promise<never>; disarm: () => void } {
    let timer: NodeJS.Timeout | undefined;
    const guard = {
      fired: false,
      expired: new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          guard.fired = true;
          conn.destroy();
          // destroy() is a graceful end(); on a dead link the FIN is never
          // acknowledged, so the socket is dropped outright.
          (conn as unknown as { connection: RawConnection }).connection.stream?.destroy();
          reject(new TimeoutError(this.config.timeoutMs));
        }, this.config.timeoutMs);
      }),
      disarm: () => clearTimeout(timer),
    };
    // A guard disarmed before its deadline never rejects; one that fires is
    // awaited through the race, so this only silences the unobserved copy.
    guard.expired.catch(() => {});
    return guard;
  }

  /**
   * Repeats a call while it is safe to. Reads repeat on dropped connections
   * (the statement never ran); both repeat on deadlocks (the transaction was
   * rolled back whole). Everything else surfaces on the first try.
   */
  private async withRetries<T>(isRead: boolean, run: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await run();
      } catch (err) {
        lastError = err;
        if (!this.retryable(err, isRead) || attempt === this.config.maxRetries) throw err;
        // Linear backoff: the failures worth repeating here (a flapping link, a
        // full connection table, a deadlock) clear in well under a second.
        await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  private retryable(err: unknown, isRead: boolean): boolean {
    if (err instanceof TimeoutError || err instanceof CredentialsError) return false;
    if (!(err instanceof MysqlError)) return false;
    if (err.errno === ER_LOCK_DEADLOCK) return true;
    return isRead && err.code !== undefined && RETRYABLE_CONNECTION_CODES.has(err.code);
  }

  /** Normalizes anything thrown by the driver into the error vocabulary. */
  private wrap(err: unknown, guard?: { fired: boolean }): Error {
    if (guard?.fired) return new TimeoutError(this.config.timeoutMs);
    if (err instanceof MysqlError || err instanceof CredentialsError || err instanceof TimeoutError) {
      return err;
    }
    const driver = err as DriverError;
    return new MysqlError(driver?.message ?? String(err), {
      code: driver?.code,
      errno: driver?.errno,
      sqlState: driver?.sqlState,
    });
  }

  /** Closes the pool. Idempotent, so shutdown paths can call it freely. */
  async close(): Promise<void> {
    const pool = this.pool;
    this.pool = null;
    if (pool) await pool.end().catch(() => {});
  }

  // ── Schema introspection ────────────────────────────────────────────────
  // All of it reads information_schema scoped to the bound database, so no
  // tool can describe a table the server is not pointed at.

  /** Tables and views of the bound database, with size and row estimates. */
  async listTables(): Promise<QueryResult> {
    return this.read(
      `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine,
              TABLE_ROWS AS rows_estimate,
              DATA_LENGTH AS data_bytes, INDEX_LENGTH AS index_bytes,
              TABLE_COLLATION AS collation, TABLE_COMMENT AS comment,
              CREATE_TIME AS created_at, UPDATE_TIME AS updated_at
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME`,
      [this.config.database],
    );
  }

  async tableColumns(table: string): Promise<QueryResult> {
    return this.read(
      `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable,
              COLUMN_KEY AS key_type, COLUMN_DEFAULT AS default_value, EXTRA AS extra,
              COLLATION_NAME AS collation, COLUMN_COMMENT AS comment
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`,
      [this.config.database, table],
    );
  }

  async tableIndexes(table: string): Promise<QueryResult> {
    return this.read(
      `SELECT INDEX_NAME AS name, NON_UNIQUE AS non_unique, SEQ_IN_INDEX AS seq,
              COLUMN_NAME AS column_name, INDEX_TYPE AS index_type,
              NULLABLE AS nullable, CARDINALITY AS cardinality, SUB_PART AS prefix_length
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
      [this.config.database, table],
    );
  }

  /** Foreign keys this table declares. */
  async tableForeignKeys(table: string): Promise<QueryResult> {
    return this.read(
      `SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS column_name,
              k.REFERENCED_TABLE_NAME AS references_table,
              k.REFERENCED_COLUMN_NAME AS references_column,
              r.UPDATE_RULE AS on_update, r.DELETE_RULE AS on_delete
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.REFERENTIAL_CONSTRAINTS r
           ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
        WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      [this.config.database, table],
    );
  }

  /**
   * Foreign keys pointing *at* this table — the direction that decides whether
   * a DELETE is safe, and the one information_schema makes easy to miss.
   */
  async tableReferencedBy(table: string): Promise<QueryResult> {
    return this.read(
      `SELECT k.TABLE_NAME AS from_table, k.COLUMN_NAME AS from_column,
              k.CONSTRAINT_NAME AS name, k.REFERENCED_COLUMN_NAME AS references_column,
              r.UPDATE_RULE AS on_update, r.DELETE_RULE AS on_delete
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.REFERENTIAL_CONSTRAINTS r
           ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
        WHERE k.REFERENCED_TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME = ?
        ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      [this.config.database, table],
    );
  }

  /** True when the name exists in the bound database — a cheap pre-flight check. */
  async tableExists(table: string): Promise<boolean> {
    const result = await this.read(
      `SELECT 1 AS found FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1`,
      [this.config.database, table],
    );
    return result.rows.length > 0;
  }

  /** Server identity, session settings and the size of the bound database. */
  async serverInfo(): Promise<QueryResult> {
    return this.read(
      `SELECT VERSION() AS server_version,
              DATABASE() AS current_database,
              CURRENT_USER() AS effective_user,
              USER() AS connected_as,
              @@character_set_database AS charset,
              @@collation_database AS collation,
              @@max_execution_time AS max_execution_time_ms,
              @@wait_timeout AS wait_timeout_s,
              @@read_only AS server_read_only`,
    );
  }

  /** Aggregate size of the bound database, for "how big is this" questions. */
  async databaseSize(): Promise<QueryResult> {
    return this.read(
      `SELECT COUNT(*) AS tables,
              COALESCE(SUM(DATA_LENGTH), 0) AS data_bytes,
              COALESCE(SUM(INDEX_LENGTH), 0) AS index_bytes,
              COALESCE(SUM(TABLE_ROWS), 0) AS rows_estimate
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?`,
      [this.config.database],
    );
  }

  /** What the MySQL user is actually allowed to do — the ground truth behind ALLOW_*. */
  async grants(): Promise<string[]> {
    const result = await this.read("SHOW GRANTS FOR CURRENT_USER()");
    return result.rows.map((row) => Object.values(row as Record<string, unknown>)[0]).map(String);
  }
}

/**
 * Makes one row safe to hand to a model. Binary columns arrive as Buffers,
 * which JSON.stringify turns into `{"type":"Buffer","data":[72,101,...]}` — a
 * per-byte array that is both unreadable and the fastest way to burn a context
 * window. They become base64, truncated with an explicit marker.
 */
const MAX_BINARY_BYTES = 256;

export function normalizeRow(row: unknown): unknown {
  if (row === null || typeof row !== "object") return row;
  const source = row as Record<string, unknown>;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    const next = normalizeValue(value);
    if (next !== value) changed = true;
    out[key] = next;
  }
  return changed ? out : row;
}

function normalizeValue(value: unknown): unknown {
  if (!Buffer.isBuffer(value)) return value;
  if (value.length <= MAX_BINARY_BYTES) return { base64: value.toString("base64"), bytes: value.length };
  return {
    base64: value.subarray(0, MAX_BINARY_BYTES).toString("base64"),
    bytes: value.length,
    truncated: true,
  };
}
