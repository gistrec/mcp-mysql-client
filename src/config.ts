import { readFileSync } from "node:fs";
import type { MysqlConfig, Permissions } from "./types.js";

/** Rows one read may return before the stream is cut short. */
export const DEFAULT_MAX_ROWS = 1000;
/** Client-side statement timeout, also pushed to the server as max_execution_time. */
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_POOL_SIZE = 3;
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_PORT = 3306;

/**
 * A malformed environment variable. Thrown instead of exiting on the spot so
 * index.ts can catch it, report the drop-off and start degraded instead of
 * dying; `reason` is the machine-readable code that ships with that ping
 * (never a variable's value). A *missing* credential is NOT a ConfigError —
 * see loadConfig.
 */
export class ConfigError extends Error {
  readonly reason: string;

  constructor(message: string, reason: string) {
    super(message);
    this.name = "ConfigError";
    this.reason = reason;
  }
}

function die(message: string, reason: string): never {
  throw new ConfigError(message, reason);
}

/** Reads a numeric env var that must be > 0, else returns the fallback. */
function positiveNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Same, but 0 is a meaningful value (no retries). */
function nonNegativeNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Boolean env vars. Only the explicit falsy words turn a default-on flag off,
 * and only the explicit truthy words turn a default-off flag on — an
 * unparseable value never silently opens a write permission.
 */
export function boolean(raw: string | undefined, fallback: boolean): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

/** True when there is enough to open a connection: a user and the bound database. */
export function hasCredentials(config: MysqlConfig): boolean {
  return Boolean(config.user && config.database && (config.socketPath || config.host));
}

/** Names the variables that are missing, so the error text is the fix. */
export function missingCredentials(config: MysqlConfig): string[] {
  const missing: string[] = [];
  if (!config.socketPath && !config.host) missing.push("MYSQL_HOST");
  if (!config.user) missing.push("MYSQL_USER");
  if (!config.database) missing.push("MYSQL_DB");
  return missing;
}

/**
 * Where the server points, in a form that is safe to print. MCP hosts capture
 * stderr to disk, so this never returns the password — only host, port and the
 * bound database.
 */
export function describeTarget(config: MysqlConfig): string {
  if (!hasCredentials(config)) return "подключение не настроено";
  const where = config.socketPath ? config.socketPath : `${config.host}:${config.port}`;
  return `${config.user}@${where}/${config.database}`;
}

/** Human-readable summary of what the server may write, for logs and instructions. */
export function describePermissions(permissions: Permissions): string {
  const allowed = (["insert", "update", "delete"] as const).filter((op) => permissions[op]);
  return allowed.length === 0 ? "только чтение" : `чтение + ${allowed.join(", ").toUpperCase()}`;
}

/**
 * Reads a secret from a file (MYSQL_PASS_FILE). An MCP client config lives in
 * plain text — ~/.claude.json is world-readable inside the user's account and
 * ends up in backups — so pointing at a file with the right mode keeps the
 * password out of it. An unreadable path is a ConfigError: silently falling
 * back to "no password" would turn a typo into a confusing 1045.
 */
function readSecretFile(path: string): string {
  try {
    return readFileSync(path, "utf8").replace(/\r?\n$/, "");
  } catch {
    die(
      "MYSQL_PASS_FILE указывает на файл, который не удалось прочитать. " +
        "Проверьте путь и права доступа (файл должен быть читаем пользователем, от которого запущен сервер).",
      "unreadable_pass_file",
    );
  }
}

/**
 * Builds the config from environment variables. The names mirror the ones
 * @benborla29/mcp-server-mysql uses, so an existing MCP client entry keeps
 * working after swapping the command.
 *
 * Missing credentials are NOT an error here: the fields stay `undefined`, the
 * server starts anyway and every tool call raises CredentialsError, so an
 * unconfigured install completes the MCP handshake and the model can name the
 * variable to set — instead of dying before `initialize` and leaving a dead
 * server with no reason. A *malformed* value still throws ConfigError, which
 * index.ts catches to degrade the same way.
 *
 *   MYSQL_HOST                     server host (default 127.0.0.1)
 *   MYSQL_PORT                     server port (default 3306)
 *   MYSQL_SOCKET_PATH              unix socket, replaces host/port
 *   MYSQL_USER                     user
 *   MYSQL_PASS / MYSQL_PASSWORD    password (empty is a valid password)
 *   MYSQL_PASS_FILE                read the password from a file instead
 *   MYSQL_DB / MYSQL_DATABASE      the one database this server is bound to
 *   MYSQL_SSL                      require TLS (default off)
 *   MYSQL_SSL_CA                   path to the CA bundle; implies MYSQL_SSL
 *   MYSQL_SSL_REJECT_UNAUTHORIZED  verify the server certificate (default on)
 *   ALLOW_INSERT_OPERATION         allow INSERT  (default off)
 *   ALLOW_UPDATE_OPERATION         allow UPDATE  (default off)
 *   ALLOW_DELETE_OPERATION         allow DELETE  (default off)
 *   MYSQL_MAX_ROWS                 row cap per read (default 1000)
 *   MYSQL_TIMEOUT_MS               statement timeout (default 30000)
 *   MYSQL_CONNECT_TIMEOUT_MS       connect timeout (default 10000)
 *   MYSQL_POOL_SIZE                pool connections (default 3)
 *   MYSQL_MAX_RETRIES              retries on lost connections / deadlocks (default 2)
 *   MYSQL_READ_ONLY_TX             wrap reads in a read-only transaction (default on)
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): MysqlConfig {
  // An empty string reads as absent, never as an empty credential.
  const socketPath = (env.MYSQL_SOCKET_PATH ?? "").trim() || undefined;
  const host = socketPath ? undefined : (env.MYSQL_HOST ?? "").trim() || "127.0.0.1";
  const user = (env.MYSQL_USER ?? "").trim() || undefined;
  // `||`, not `??`: an empty MYSQL_DB must fall through to the alias, and an
  // empty string is not nullish. Same for the password below.
  const database = (env.MYSQL_DB || env.MYSQL_DATABASE || "").trim() || undefined;

  const portRaw = (env.MYSQL_PORT ?? "").trim();
  if (portRaw && !/^\d+$/.test(portRaw)) {
    // The accepted shape, never the rejected value: this lands on stderr, which
    // MCP hosts capture to disk.
    die("MYSQL_PORT должен быть целым числом от 1 до 65535, например 3306.", "invalid_port");
  }
  const port = portRaw ? Number(portRaw) : DEFAULT_PORT;
  if (port < 1 || port > 65535) {
    die("MYSQL_PORT должен быть целым числом от 1 до 65535, например 3306.", "invalid_port");
  }

  // A password may legitimately be empty (a local socket install), so absence
  // and emptiness are the same thing here — unlike the identity variables.
  const passFile = (env.MYSQL_PASS_FILE ?? "").trim();
  const password = passFile ? readSecretFile(passFile) : env.MYSQL_PASS || env.MYSQL_PASSWORD || undefined;

  const caPath = (env.MYSQL_SSL_CA ?? "").trim();
  // A CA path is a request for TLS on its own — nobody points at a bundle and
  // then expects a plaintext connection.
  const sslWanted = boolean(env.MYSQL_SSL, false) || Boolean(caPath);
  let ssl: MysqlConfig["ssl"];
  if (sslWanted) {
    let ca: string | undefined;
    if (caPath) {
      try {
        ca = readFileSync(caPath, "utf8");
      } catch {
        die(
          "MYSQL_SSL_CA указывает на файл сертификата, который не удалось прочитать. " +
            "Проверьте путь и права доступа.",
          "unreadable_ssl_ca",
        );
      }
    }
    ssl = {
      ca,
      rejectUnauthorized: boolean(env.MYSQL_SSL_REJECT_UNAUTHORIZED, true),
    };
  }

  return {
    host,
    port,
    socketPath,
    user,
    password,
    database,
    ssl,
    permissions: {
      insert: boolean(env.ALLOW_INSERT_OPERATION, false),
      update: boolean(env.ALLOW_UPDATE_OPERATION, false),
      delete: boolean(env.ALLOW_DELETE_OPERATION, false),
    },
    maxRows: positiveNumber(env.MYSQL_MAX_ROWS, DEFAULT_MAX_ROWS),
    timeoutMs: positiveNumber(env.MYSQL_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    connectTimeoutMs: positiveNumber(env.MYSQL_CONNECT_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS),
    poolSize: positiveNumber(env.MYSQL_POOL_SIZE, DEFAULT_POOL_SIZE),
    maxRetries: nonNegativeNumber(env.MYSQL_MAX_RETRIES, DEFAULT_MAX_RETRIES),
    readOnlyTransactions: boolean(env.MYSQL_READ_ONLY_TX, true),
  };
}
