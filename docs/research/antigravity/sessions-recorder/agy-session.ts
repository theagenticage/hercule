// Scratch toolkit: runs `agy acp` for one account home and records every JSON-RPC message both ways.
// Recording format, one JSON object per line: { t: ms since start, direction: "in"|"out", message }.
// "in" = sent by agy (stderr lines are { stderr }), "out" = sent by us.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const AGY_BINARY = "/tmp/hercule-1282/agy/antigravity";

export type Msg = any;
export type RequestHandler = (message: Msg) => void | Promise<void>;

export interface StartOptions {
  home: string;
  cwd: string;
  out: string;
  extraFlags?: string[];
  proxy?: { url: string };
  /** Append to `out` instead of truncating it (several processes in one recording). */
  append?: boolean;
}

export interface Agy {
  pid: number;
  messages: Msg[];
  request(method: string, params?: unknown): Promise<Msg>;
  notify(method: string, params?: unknown): void;
  respond(id: number | string, result: unknown): void;
  respondError(id: number | string, code: number, message: string): void;
  /** Resolves with the first incoming message at index >= fromIndex that matches. Rejects on timeout. */
  waitFor(predicate: (m: Msg) => boolean, timeoutMs: number, fromIndex?: number): Promise<Msg>;
  onRequest(handler: RequestHandler): void;
  note(text: string): void;
  close(): Promise<void>;
}

const buildEnv = (proxy?: { url: string }): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(GEMINI_|GOOGLE_|AGY_)/.test(k)) env[k] = v;
  }
  env.SSH_CONNECTION = "127.0.0.1 0 127.0.0.1 0";
  env.AGY_CLI_DISABLE_AUTO_UPDATE = "true";
  if (proxy) for (const k of ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"]) env[k] = proxy.url;
  return env;
};

export const startAgy = (opts: StartOptions): Agy => {
  mkdirSync(dirname(opts.out), { recursive: true });
  mkdirSync(opts.cwd, { recursive: true });
  if (!opts.append) writeFileSync(opts.out, "");
  const logFolder = mkdtempSync(join(opts.home, "rec-log-"));
  // mkdtemp already makes it 0700
  const started = Date.now();
  const record = (direction: "in" | "out", message: unknown) =>
    appendFileSync(opts.out, `${JSON.stringify({ t: Date.now() - started, direction, message })}\n`);

  const child = Bun.spawn(
    [
      AGY_BINARY, "acp", "--process-per-session",
      "--gemini-dir", opts.home, "--app-data-dir", "antigravity-acp",
      "--log-file", join(logFolder, "agy.log"),
      ...(opts.extraFlags ?? []),
    ],
    { cwd: opts.cwd, env: buildEnv(opts.proxy), stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );

  const messages: Msg[] = [];
  const pending = new Map<number, (m: Msg) => void>();
  const watchers = new Set<() => void>();
  let handler: RequestHandler | undefined;
  let nextId = 1;
  let closed = false;

  const send = (message: unknown) => {
    record("out", message);
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
      child.stdin.flush();
    } catch {
      // process already gone; the recording keeps the attempt
    }
  };

  const handle = (message: Msg) => {
    record("in", message);
    messages.push(message);
    if (message.method === undefined && message.id !== undefined) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    } else if (message.method !== undefined && message.id !== undefined) {
      // agy -> client request
      const known = message.method === "session/request_permission" || message.method === "elicitation/create" || String(message.method).startsWith("fs/");
      if (known && handler) {
        Promise.resolve(handler(message)).catch((e) => record("out", { handlerError: String(e) }));
      } else {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
      }
    }
    for (const w of [...watchers]) w();
  };

  const readStdout = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim() === "") continue;
        try {
          handle(JSON.parse(line));
        } catch {
          record("in", { stdoutNotJson: line });
        }
      }
    }
    if (buffer.trim() !== "") record("in", { stdoutNotJson: buffer });
  })();
  const readStderr = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of child.stderr) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        record("in", { stderr: buffer.slice(0, nl) });
        buffer = buffer.slice(nl + 1);
      }
    }
    if (buffer !== "") record("in", { stderr: buffer });
  })();

  const agy: Agy = {
    pid: child.pid,
    messages,
    request(method, params) {
      return new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        send({ jsonrpc: "2.0", id, method, params });
      });
    },
    notify(method, params) {
      send({ jsonrpc: "2.0", method, params });
    },
    respond(id, result) {
      send({ jsonrpc: "2.0", id, result });
    },
    respondError(id, code, message) {
      send({ jsonrpc: "2.0", id, error: { code, message } });
    },
    waitFor(predicate, timeoutMs, fromIndex = 0) {
      return new Promise((resolve, reject) => {
        let cursor = fromIndex;
        const timer = setTimeout(() => {
          watchers.delete(check);
          reject(new Error(`waitFor timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        const check = () => {
          while (cursor < messages.length) {
            const m = messages[cursor++];
            if (predicate(m)) {
              clearTimeout(timer);
              watchers.delete(check);
              resolve(m);
              return;
            }
          }
        };
        watchers.add(check);
        check();
      });
    },
    onRequest(h) {
      handler = h;
    },
    note(text) {
      record("out", { note: text });
    },
    async close() {
      if (closed) return;
      closed = true;
      const exited = child.exited;
      try { child.kill("SIGTERM"); } catch {}
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000);
      await exited;
      clearTimeout(timer);
      await Promise.all([readStdout, readStderr]);
      if (!process.env.KEEPLOG) rmSync(logFolder, { recursive: true, force: true });
    },
  };
  return agy;
};

/** Sleeps for `ms`. */
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const DEFAULT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  elicitation: { form: {} },
};

export interface OpenedSession {
  sessionId: string;
  initialize: Msg;
  authenticate: Msg;
  session: Msg;
}

/** initialize, authenticate, then session/new or session/resume. Throws when session open fails. */
export const openSession = async (
  agy: Agy,
  o: { cwd: string; resumeId?: string; systemPromptAppend?: string; mcpServers?: unknown[]; clientCapabilities?: unknown },
): Promise<OpenedSession> => {
  const initialize = await agy.request("initialize", {
    protocolVersion: 1,
    clientInfo: { name: "hercule", version: "0.0.0-recorder" },
    clientCapabilities: o.clientCapabilities ?? DEFAULT_CAPABILITIES,
  });
  const authenticate = await agy.request("authenticate", { methodId: "oauth-personal" });
  const params: Record<string, unknown> = { cwd: o.cwd, mcpServers: o.mcpServers ?? [] };
  if (o.resumeId) params.sessionId = o.resumeId;
  if (o.systemPromptAppend) params._meta = { antigravity: { systemPrompt: { append: o.systemPromptAppend } } };
  const session = await agy.request(o.resumeId ? "session/resume" : "session/new", params);
  if (session.error) throw new Error(`${o.resumeId ? "session/resume" : "session/new"} failed: ${JSON.stringify(session.error)}`);
  return { sessionId: o.resumeId ?? session.result.sessionId, initialize, authenticate, session };
};

export const text = (value: string) => [{ type: "text", text: value }];

/** Sends session/prompt; resolves with the reply. */
export const prompt = (agy: Agy, sessionId: string, value: string | unknown[]) =>
  agy.request("session/prompt", { sessionId, prompt: typeof value === "string" ? text(value) : value });

export const summarize = (name: string, reply: Msg): string =>
  `${name}: ${reply?.error ? `error ${JSON.stringify(reply.error)}` : `stopReason=${reply?.result?.stopReason ?? JSON.stringify(reply?.result)}`}`;

/** Picks the option of a permission request by kind (falls back to the first). */
export const pickOption = (request: Msg, kind: string): string => {
  const options = (request.params?.options ?? []) as Array<{ kind: string; optionId: string }>;
  return (options.find((o) => o.kind === kind) ?? options[0])?.optionId;
};

export const select = (agy: Agy, request: Msg, kind: string) =>
  agy.respond(request.id, { outcome: { outcome: "selected", optionId: pickOption(request, kind) } });

/** Makes a fresh empty working folder under /tmp/hercule-1282/work/<name>/ with optional files. */
export const freshWork = (name: string, files: Record<string, string> = {}): string => {
  const dir = `${process.env.WORKROOT ?? "/tmp/hercule-1282/work"}/${name}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [f, c] of Object.entries(files)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), c); }
  return dir;
};

export interface ScenarioContext {
  home: string;
  out: string;
  cwd: string;
}

/**
 * Runs a scenario body with a started agy and a session, prints the summary, always closes agy.
 * `body` returns the summary line.
 */
export const runScenario = async (
  name: string,
  files: Record<string, string>,
  start: Omit<StartOptions, "home" | "cwd" | "out">,
  body: (agy: Agy, ctx: ScenarioContext) => Promise<string>,
): Promise<void> => {
  const [home, outDir] = process.argv.slice(2);
  if (!home || !outDir) {
    console.error(`usage: bun scenarios/${name}.ts <home> <outDir>`);
    process.exit(2);
  }
  const cwd = freshWork(name, files);
  const out = join(outDir, `${name}.jsonl`);
  const agy = startAgy({ home, cwd, out, ...start });
  const timer = setTimeout(() => { console.log(`${name}: HARD TIMEOUT 600s`); void agy.close().then(() => process.exit(1)); }, 600_000);
  try {
    console.log(await body(agy, { home, out, cwd }));
  } catch (e) {
    console.log(`${name}: FAILED ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    await agy.close();
  }
};

export const FULL_ACCESS = ["--dangerously-skip-permissions"];

/** Answers every permission request with `kind` (and every elicitation with decline unless `elicit` is given). */
export const autoPermission = (agy: Agy, kind = "allow_once", elicit?: (m: Msg) => unknown) => {
  agy.onRequest((m) => {
    if (m.method === "session/request_permission") select(agy, m, kind);
    else agy.respond(m.id, elicit ? elicit(m) : { action: "decline" });
  });
};

/** Sets the mode and returns the reply. */
export const setMode = (agy: Agy, sessionId: string, modeId: string) => agy.request("session/set_mode", { sessionId, modeId });

/** Waits for a tool_call-ish session/update, or rejects after `ms`. */
export const isUpdate = (kind: string) => (m: Msg) => m.method === "session/update" && m.params?.update?.sessionUpdate === kind;
