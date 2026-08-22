/**
 * Shared types and the error vocabulary. Every failure the server can produce
 * is one of the classes below, so `fail()` in tools/util.ts can turn it into a
 * message that names the fix instead of leaking a driver stack trace.
 */

/** Which write statements the operator has enabled. Reads are always allowed. */
export interface Permissions {
  insert: boolean;
  update: boolean;
  delete: boolean;
}

export interface MysqlConfig {
  host?: string;
  port: number;
  /** Unix socket; when set it replaces host/port. */
  socketPath?: string;
  user?: string;
  password?: string;
  /** The single database this server is bound to. No tool can leave it. */
  database?: string;
  ssl?: SslConfig;
  permissions: Permissions;
  /** Hard cap on rows returned by one read; the stream stops there. */
  maxRows: number;
  /** Client-side statement timeout; the connection is destroyed on expiry. */
  timeoutMs: number;
  connectTimeoutMs: number;
  poolSize: number;
  /** Retries for connection-level failures on reads and for deadlocks. */
  maxRetries: number;
  /** Wrap every read in START TRANSACTION READ ONLY (server-side guarantee). */
  readOnlyTransactions: boolean;
  /** Set when a malformed variable degraded the config; reported to the model. */
  configProblem?: string;
}

export interface SslConfig {
  ca?: string;
  rejectUnauthorized: boolean;
}

/** One column of a result set, as the driver reported it. */
export interface ColumnInfo {
  name: string;
  type: string;
}

export interface QueryResult {
  rows: unknown[];
  rowCount: number;
  /** True when maxRows cut the result short — the answer is a prefix, not the whole set. */
  truncated: boolean;
  columns?: ColumnInfo[];
  durationMs: number;
}

export interface WriteResult {
  affectedRows: number;
  /** UPDATE only: rows whose values actually changed (affected includes no-op matches). */
  changedRows?: number;
  insertId?: number | string;
  warningCount?: number;
  info?: string;
  durationMs: number;
}

/**
 * The environment does not describe a usable connection. Thrown at call time,
 * never at startup: the server must complete the MCP handshake so the model can
 * relay the fix (see the degraded-start contract in index.ts).
 */
export class CredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialsError";
  }
}

/** The request is malformed — rejected before a connection is even taken. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * The statement is well-formed but this server is not allowed to run it: a
 * write with the matching ALLOW_* flag off, DDL (never supported), or a
 * statement class that would escape the sandbox (USE, PREPARE, LOAD DATA…).
 */
export class PermissionError extends Error {
  /** Machine-readable statement class, e.g. "delete" or "ddl". */
  readonly kind: string;

  constructor(message: string, kind: string) {
    super(message);
    this.name = "PermissionError";
    this.kind = kind;
  }
}

/** The statement outlived MYSQL_TIMEOUT_MS and its connection was destroyed. */
export class TimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(
      `Запрос не уложился в ${timeoutMs} мс и был прерван (соединение разорвано). ` +
        "Сузьте выборку, добавьте LIMIT или поднимите MYSQL_TIMEOUT_MS.",
    );
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * A failure reported by MySQL or by the driver. Keeps the driver's own codes so
 * `fail()` can attach the hint that matches (1045 is the password, 1044 is the
 * grant on the database, 1142 is the grant on the table — three different fixes
 * behind three near-identical "access denied" texts).
 */
export class MysqlError extends Error {
  readonly code: string | undefined;
  readonly errno: number | undefined;
  readonly sqlState: string | undefined;

  constructor(message: string, source: { code?: string; errno?: number; sqlState?: string } = {}) {
    super(message);
    this.name = "MysqlError";
    this.code = source.code;
    this.errno = source.errno;
    this.sqlState = source.sqlState;
  }
}

/** Shape of the driver errors we read fields off of. */
export interface DriverError extends Error {
  code?: string;
  errno?: number;
  sqlState?: string;
  fatal?: boolean;
}
