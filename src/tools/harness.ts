import type { z } from "zod";

/**
 * Fake server + fake client for the tool tests, so the handlers run with no
 * database and no McpServer. `methods` maps client method names to what their
 * fake resolves with — a value, or a function called with the arguments.
 */

type Args = Record<string, unknown>;
export type Handler = (args: Args) => Promise<{ content: { text: string }[]; isError?: boolean }>;

export interface Annotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolConfig {
  title?: string;
  description?: string;
  annotations?: Annotations;
  inputSchema?: z.ZodRawShape;
}

export interface Harness {
  calls: { method: string; params: unknown[] }[];
  configs: Record<string, ToolConfig>;
  tools: Record<string, Handler>;
}

/** An empty read result, the shape every client read method resolves with. */
export function rows(list: unknown[], extra: Record<string, unknown> = {}) {
  return { rows: list, rowCount: list.length, truncated: false, durationMs: 1, ...extra };
}

/**
 * Builds the harness for one register function. `extra` carries whatever the
 * register function takes after the client (config, permissions).
 */
export function harness(
  register: (...args: never[]) => void,
  methods: Record<string, unknown>,
  extra: unknown[] = [],
  opts: { throwOn?: string; error?: Error } = {},
): Harness {
  const calls: { method: string; params: unknown[] }[] = [];
  const client: Record<string, unknown> = {};
  for (const [method, value] of Object.entries(methods)) {
    client[method] = async (...params: unknown[]) => {
      calls.push({ method, params });
      if (opts.throwOn === method) throw opts.error ?? new Error(`${method} отклонён`);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown)(...params) : value;
    };
  }
  const configs: Record<string, ToolConfig> = {};
  const tools: Record<string, Handler> = {};
  const server = {
    registerTool: (name: string, cfg: ToolConfig, handler: Handler) => {
      configs[name] = cfg;
      tools[name] = handler;
    },
  };
  (register as (...args: unknown[]) => void)(server, client, ...extra);
  return { calls, configs, tools };
}

/** Joins a tool result's text content, for assertions. */
export function textOf(result: { content: { text: string }[] }): string {
  return result.content.map((part) => part.text ?? "").join(" ");
}
