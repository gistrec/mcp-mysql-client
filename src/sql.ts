/**
 * Statement classification — the gate every SQL string passes before a
 * connection is taken.
 *
 * The rule this file exists to enforce: the server decides what a statement
 * *is* by parsing it itself, never by trusting the caller's choice of tool. A
 * model that puts `DELETE` into `query` must be refused, not obeyed.
 *
 * The scanner is deliberately conservative and lexical: it tracks strings,
 * quoted identifiers and comments so keywords inside them are not mistaken for
 * verbs, splits on `;` to reject multi-statement payloads, and classifies by
 * the leading verb. It is not a full MySQL grammar and does not pretend to be —
 * the second line of defence is server-side (reads run inside START TRANSACTION
 * READ ONLY, so a statement that slips past this file still cannot write), and
 * the third is the grants of the MySQL user itself.
 */
import { PermissionError, ValidationError, type Permissions } from "./types.js";

export type StatementKind = "read" | "insert" | "update" | "delete" | "replace" | "ddl" | "forbidden";

export interface Analysis {
  /** What running this statement would do, in the vocabulary of the permissions. */
  kind: StatementKind;
  /** Leading keyword, upper-cased — e.g. SELECT, INSERT, DROP. */
  verb: string;
  /** The single statement, comments stripped and the trailing `;` removed. */
  statement: string;
  /** Bare words outside strings, quoted identifiers and comments, upper-cased. */
  tokens: string[];
  /** Set for kind "forbidden": why this class of statement is refused. */
  reason?: string;
}

const READ_VERBS = new Set(["SELECT", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "TABLE", "VALUES", "WITH"]);

const WRITE_VERBS = new Map<string, StatementKind>([
  ["INSERT", "insert"],
  ["UPDATE", "update"],
  ["DELETE", "delete"],
  ["REPLACE", "replace"],
]);

const DDL_VERBS = new Set(["CREATE", "ALTER", "DROP", "RENAME", "TRUNCATE"]);

/**
 * Why each refused class is refused. These are the statements that would escape
 * the sandbox rather than merely write to it: they change what the *next*
 * statement means (USE, SET), execute text this scanner never saw (PREPARE,
 * CALL), read or write files (LOAD), or take the connection out of the
 * server's own transaction handling (START, COMMIT, LOCK).
 */
const FORBIDDEN_REASONS: Record<string, string> = {
  USE: "смена базы данных запрещена: сервер привязан к одной базе из MYSQL_DB",
  SET: "изменение сессионных переменных запрещено: оно снимает ограничения, на которых держится режим только чтения",
  CALL: "вызов хранимой процедуры запрещён: её тело не проходит проверку и может писать в базу",
  LOAD: "LOAD DATA запрещён: он читает файлы сервера или клиента",
  PREPARE: "PREPARE/EXECUTE запрещены: они выполняют текст, который сервер не проверял",
  EXECUTE: "PREPARE/EXECUTE запрещены: они выполняют текст, который сервер не проверял",
  DEALLOCATE: "PREPARE/EXECUTE запрещены: они выполняют текст, который сервер не проверял",
  START: "управление транзакциями закреплено за сервером: чтения и так идут в read-only транзакции",
  BEGIN: "управление транзакциями закреплено за сервером: чтения и так идут в read-only транзакции",
  COMMIT: "управление транзакциями закреплено за сервером: чтения и так идут в read-only транзакции",
  ROLLBACK: "управление транзакциями закреплено за сервером: чтения и так идут в read-only транзакции",
  SAVEPOINT: "управление транзакциями закреплено за сервером: чтения и так идут в read-only транзакции",
  LOCK: "блокировки таблиц запрещены: соединение живёт в пуле и залипшая блокировка остановит базу",
  UNLOCK: "блокировки таблиц запрещены: соединение живёт в пуле и залипшая блокировка остановит базу",
  HANDLER: "HANDLER запрещён: он читает таблицу в обход оптимизатора и держит открытый курсор",
  GRANT: "изменение прав запрещено",
  REVOKE: "изменение прав запрещено",
  KILL: "KILL запрещён: он снимает чужие соединения к серверу",
  FLUSH: "административные команды сервера запрещены",
  RESET: "административные команды сервера запрещены",
  SHUTDOWN: "административные команды сервера запрещены",
  RESTART: "административные команды сервера запрещены",
  OPTIMIZE: "обслуживание таблиц запрещено: команда перестраивает таблицу и блокирует её",
  REPAIR: "обслуживание таблиц запрещено: команда перестраивает таблицу и блокирует её",
  ANALYZE: "обслуживание таблиц запрещено: команда переписывает статистику таблицы",
  CHECK: "обслуживание таблиц запрещено",
  CHECKSUM: "обслуживание таблиц запрещено: команда читает таблицу целиком",
  INSTALL: "управление плагинами запрещено",
  UNINSTALL: "управление плагинами запрещено",
  XA: "распределённые транзакции запрещены",
  PURGE: "административные команды сервера запрещены",
  BINLOG: "административные команды сервера запрещены",
  CHANGE: "административные команды сервера запрещены",
  CLONE: "административные команды сервера запрещены",
};

/** Tokens that may precede the real statement inside EXPLAIN / DESCRIBE. */
const EXPLAIN_MODIFIERS = new Set([
  "EXPLAIN",
  "DESCRIBE",
  "DESC",
  "ANALYZE",
  "FORMAT",
  "JSON",
  "TREE",
  "TRADITIONAL",
  "EXTENDED",
  "PARTITIONS",
  "INTO",
  "FOR",
  "CONNECTION",
  "SCHEMA",
]);

interface ScannedStatement {
  text: string;
  tokens: string[];
}

/**
 * Splits SQL into statements, dropping comments and never confusing a keyword
 * inside a literal for a verb.
 *
 * `/*!` (MySQL's version-gated executable comment) is refused outright: the
 * server *runs* what is inside it, so stripping it as a comment would hide a
 * `/*!50000 DELETE FROM t *​/` from every check below — the exact trick a
 * comment-stripping filter is supposed to catch.
 */
export function scan(sql: string): ScannedStatement[] {
  const statements: ScannedStatement[] = [];
  let text = "";
  let tokens: string[] = [];
  let word = "";

  const endWord = () => {
    if (word) {
      tokens.push(word.toUpperCase());
      word = "";
    }
  };
  const endStatement = () => {
    endWord();
    if (text.trim()) statements.push({ text: text.trim(), tokens });
    text = "";
    tokens = [];
  };

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    // Comments. A block comment is replaced by a space so `SELECT/**/1` does
    // not become the single word `SELECT1`.
    if (ch === "-" && next === "-" && (sql[i + 2] === undefined || /\s/.test(sql[i + 2] ?? ""))) {
      endWord();
      while (i < sql.length && sql[i] !== "\n") i++;
      text += " ";
      continue;
    }
    if (ch === "#") {
      endWord();
      while (i < sql.length && sql[i] !== "\n") i++;
      text += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      endWord();
      if (sql[i + 2] === "!") {
        throw new ValidationError(
          "Исполняемые комментарии MySQL (/*! ... */) запрещены: сервер выполняет их содержимое, " +
            "и проверка типа запроса перестаёт что-либо значить. Уберите их из SQL.",
        );
      }
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) throw new ValidationError("Незакрытый комментарий /* в SQL.");
      i = end + 1;
      text += " ";
      continue;
    }

    // Literals and quoted identifiers: copied verbatim, never tokenized.
    if (ch === "'" || ch === '"' || ch === "`") {
      endWord();
      const quote = ch;
      text += ch;
      i++;
      while (i < sql.length) {
        const cur = sql[i];
        // Backslash escapes apply to strings (NO_BACKSLASH_ESCAPES off, the
        // default), never to backtick identifiers.
        if (cur === "\\" && quote !== "`" && i + 1 < sql.length) {
          text += cur + sql[i + 1];
          i += 2;
          continue;
        }
        if (cur === quote) {
          // A doubled quote is an escaped quote, not the end of the literal.
          if (sql[i + 1] === quote) {
            text += cur + cur;
            i += 2;
            continue;
          }
          text += cur;
          break;
        }
        text += cur;
        i++;
      }
      if (i >= sql.length) throw new ValidationError(`Незакрытая кавычка ${quote} в SQL.`);
      continue;
    }

    if (ch === ";") {
      endStatement();
      continue;
    }

    // Word characters. `$` and `_` are legal in unquoted identifiers.
    if (ch !== undefined && /[A-Za-z0-9_$]/.test(ch)) {
      word += ch;
    } else {
      endWord();
    }
    text += ch;
  }
  endStatement();

  return statements;
}

/**
 * Classifies one SQL string. Throws ValidationError when the input is not a
 * single runnable statement — multi-statement payloads are refused here rather
 * than relying on the driver's `multipleStatements: false`, so the caller gets
 * an explanation instead of a syntax error.
 */
export function analyze(sql: string): Analysis {
  const statements = scan(sql);
  if (statements.length === 0) {
    throw new ValidationError("Пустой SQL-запрос.");
  }
  if (statements.length > 1) {
    throw new ValidationError(
      `В запросе ${statements.length} инструкции, а выполняется ровно одна. ` +
        "Разделите их и вызовите инструмент несколько раз.",
    );
  }

  const { text, tokens } = statements[0]!;
  const verb = tokens[0] ?? "";
  const base: Omit<Analysis, "kind"> = { verb, statement: text, tokens };

  if (!verb) throw new ValidationError("Пустой SQL-запрос.");

  // Writing a file from a SELECT is still writing, and it lands on the database
  // server's filesystem where nothing above can see it.
  if (tokens.includes("OUTFILE") || tokens.includes("DUMPFILE")) {
    return {
      ...base,
      kind: "forbidden",
      reason: "SELECT ... INTO OUTFILE/DUMPFILE запрещён: он создаёт файл на файловой системе сервера базы",
    };
  }

  if (DDL_VERBS.has(verb)) {
    return {
      ...base,
      kind: "ddl",
      reason:
        "DDL (CREATE/ALTER/DROP/RENAME/TRUNCATE) не поддерживается ни при каких настройках: " +
        "схему меняют миграциями, а не из диалога",
    };
  }

  const writeKind = WRITE_VERBS.get(verb);
  if (writeKind) return { ...base, kind: writeKind };

  if (READ_VERBS.has(verb)) {
    // A CTE can front a write in MySQL 8 (`WITH x AS (...) DELETE FROM ...`),
    // and EXPLAIN ANALYZE actually runs its statement. Both are classified by
    // what they would end up doing, not by the word they start with.
    if (verb === "WITH") return { ...base, kind: cteKind(tokens) };
    if (verb === "EXPLAIN" || verb === "DESCRIBE" || verb === "DESC") {
      return { ...base, kind: explainKind(tokens) };
    }
    return { ...base, kind: "read" };
  }

  return {
    ...base,
    kind: "forbidden",
    reason: FORBIDDEN_REASONS[verb] ?? `инструкция ${verb} не входит в поддерживаемый набор`,
  };
}

/**
 * A CTE prelude hides the real verb. Reserved words cannot be bare identifiers
 * in MySQL, so a bare INSERT/UPDATE/DELETE/REPLACE token outside strings and
 * backticks can only be the statement's own verb.
 */
function cteKind(tokens: string[]): StatementKind {
  for (const token of tokens) {
    const kind = WRITE_VERBS.get(token);
    if (kind) return kind;
    if (DDL_VERBS.has(token)) return "ddl";
  }
  return "read";
}

/**
 * `EXPLAIN <stmt>` is classified by `<stmt>`: EXPLAIN ANALYZE executes what it
 * explains, and telling the two apart lexically is not worth the risk — an
 * `EXPLAIN DELETE` simply needs the DELETE permission.
 */
function explainKind(tokens: string[]): StatementKind {
  for (const token of tokens) {
    if (EXPLAIN_MODIFIERS.has(token)) continue;
    const kind = WRITE_VERBS.get(token);
    if (kind) return kind;
    if (DDL_VERBS.has(token)) return "ddl";
    // `EXPLAIN tbl_name` (a describe in disguise) or the SELECT itself.
    return "read";
  }
  return "read";
}

/** True when an UPDATE/DELETE is bounded by a WHERE or a LIMIT. */
export function isBounded(analysis: Analysis): boolean {
  return analysis.tokens.includes("WHERE") || analysis.tokens.includes("LIMIT");
}

/**
 * Gate for the read path. Anything that is not a pure read is refused here —
 * including writes the server *is* allowed to make, because they belong to the
 * write tool where they are visible as such to the user approving the call.
 */
export function assertReadable(analysis: Analysis): void {
  if (analysis.kind === "read") return;
  if (analysis.kind === "forbidden" || analysis.kind === "ddl") {
    throw new PermissionError(`Запрос отклонён: ${analysis.reason}.`, analysis.kind);
  }
  throw new PermissionError(
    `Этот инструмент выполняет только чтение, а запрос начинается с ${analysis.verb}. ` +
      "Изменяющие данные запросы выполняет инструмент execute.",
    analysis.kind,
  );
}

/**
 * Gate for the write path: the statement must be a write *and* carry the flag
 * the operator turned on. The message names the exact variable and says a
 * restart is needed — permissions come only from the environment, so nothing
 * the model does in-session can widen them.
 */
export function assertWritable(analysis: Analysis, permissions: Permissions): void {
  if (analysis.kind === "read") {
    throw new PermissionError(
      "Это читающий запрос — выполните его инструментом query, он возвращает строки.",
      "read",
    );
  }
  if (analysis.kind === "forbidden" || analysis.kind === "ddl") {
    throw new PermissionError(`Запрос отклонён: ${analysis.reason}.`, analysis.kind);
  }

  // REPLACE is an INSERT that may silently delete the row it collides with, so
  // it needs both grants — the delete is the part nobody expects.
  const required: (keyof Permissions)[] =
    analysis.kind === "replace" ? ["insert", "delete"] : [analysis.kind as keyof Permissions];
  const missing = required.filter((op) => !permissions[op]);
  if (missing.length === 0) return;

  const vars = missing.map((op) => `ALLOW_${op.toUpperCase()}_OPERATION=true`).join(" и ");
  const extra =
    analysis.kind === "replace"
      ? " REPLACE удаляет строку, конфликтующую по ключу, поэтому требует и права на удаление."
      : "";
  throw new PermissionError(
    `${analysis.verb} запрещён: сервер запущен без ${vars}.${extra} ` +
      "Разрешение выдаётся только в конфигурации MCP-клиента с последующим перезапуском сервера — " +
      "из диалога его получить нельзя.",
    analysis.kind,
  );
}
