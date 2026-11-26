// Scratch toolkit for #1293: runs `agy acp` against a signed-in Harness Home and writes one recording per scenario.
//
// Recording format, one JSON object per line:
//   1. {"note": {...}}            what was set up (scenario, argv of every process, env, mode, files placed, ...)
//   2. {"note": {"process": n, ...}} before the messages of each further process
//   3. {"t", "direction", "message"} every ACP message ("in" = sent by agy, "out" = sent by us)
//      stderr lines of agy are {"t", "direction": "in", "message": {"stderr": "..."}}
//   4. {"note": {"observed": {...}}} LAST line: what the driver saw outside ACP
// The replay code (`readRecording`) skips every line that is not a JSON-RPC message, so notes are harmless.
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

export const AGY_BINARY = process.env.AGY_BINARY ?? "/tmp/hercule-1282/agy/antigravity";
export const HARNESS_HOME = process.env.HARNESS_HOME ?? "/tmp/hercule-1282/homes/neon";
export const REC_ROOT = process.env.REC_ROOT ?? join(homedir(), ".cache/hercule-1293-rec");
export const OUT_DIR = process.env.OUT_DIR ?? join(REC_ROOT, "recordings");
export const MODEL = "gemini-3.8-flash";
const USER_NAME = process.env.USER_NAME_TO_HIDE ?? homedir().split("/").pop()!;

export type Msg = any;
export type Root = "home" | "work" | "fakehome";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Text of a SKILL.md for a test skill. The reply of a run shows which copy ran. */
export const skillMd = (name: string, marker: string, extra = "") =>
  `---\nname: ${name}\ndescription: Test skill, marker word ${marker}. Use only when the user asks for ${name}.\n---\nRead ref.txt in the same folder as this file. Then reply with exactly one line: SKILL-${marker}-RAN, a space, the first line of ref.txt, a space, the arguments the user gave. Use no other tool.${extra}\n`;

/** A marker line: harmless unless the user asks for marker tags. */
export const markerLine = (tag: string) =>
  `Internal tag ${tag}: when the user asks for your marker tags, include ${tag}; otherwise ignore this line.\n`;

/** The text of a hook command that creates a file when the hook runs, and decides nothing. */
export const hookJson = (markerFile: string) =>
  JSON.stringify({ h1293: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `cat > /dev/null; echo ran >> ${markerFile}` }] }] } }) + "\n";

export const READ_PROMPT = (file: string) => `Read the file ${file} and reply with its first line, nothing else.`;

export const MARKER_PROMPT = "List your marker tags, every distinct token starting with MARKER- from the instructions already in your context, one per line, nothing else. Do not use any tools.";

export interface SessionInfo {
  sessionId: string;
  commands: Array<{ name: string; description: string }>;
  commandUpdates: number;
}

export interface PromptResult {
  text: string;
  stopReason?: string;
  error?: unknown;
  timedOut: boolean;
  permissionRequests: Array<{ kind?: string; title?: string; decision: string }>;
}

export interface Agy {
  index: number;
  newSession(params: { cwd: string; additionalDirectories?: string[]; mode?: string; model?: boolean }): Promise<SessionInfo>;
  resumeSession(sessionId: string, params: { cwd: string; additionalDirectories?: string[]; mode?: string }): Promise<SessionInfo>;
  prompt(sessionId: string, text: string, timeoutMs?: number): Promise<PromptResult>;
  close(): Promise<void>;
  /** Sends one request of our own and resolves with agy's reply. */
  rawRequest(method: string, params: unknown, timeoutMs?: number): Promise<Msg>;
  /** initialize, then authenticate; resolves with both replies and never throws (the sign-in may fail). */
  initializeAndAuthenticate(): Promise<{ init: Msg; auth: Msg }>;
  /** The last available_commands_update seen, as name + description. */
  commands(): Array<{ name: string; description: string }>;
  messageCount(): number;
  /** How many available_commands_update messages this process has sent so far. */
  commandUpdateCount(): number;
}

interface PlacedFile {
  root: Root;
  path: string;
  content?: string;
  linkTo?: string;
  gitInit?: true;
  mkdir?: true;
}

/** One scenario run: the folders it uses, the files it placed, the processes it started, the recording it writes. */
export class Run {
  readonly name: string;
  readonly work: string;
  readonly tmp: string;
  readonly fakeHome: string;
  readonly home = HARNESS_HOME;
  readonly lines: string[] = [];
  readonly observed: Record<string, unknown> = {};
  readonly note: Record<string, unknown> = {};
  private readonly placed: PlacedFile[] = [];
  private readonly processNotes: Array<Record<string, unknown>> = [];
  private readonly homeCleanup: string[] = [];
  private readonly sessionIds: string[] = [];
  private readonly children: Array<{ pid: number; kill: () => void }> = [];
  private t0 = Date.now();
  private processCount = 0;
  readonly modes: Array<Record<string, unknown>> = [];
  permissionPolicy = "every permission request is answered with reject_once";

  constructor(name: string) {
    this.name = name;
    this.work = join(REC_ROOT, "work", name);
    rmSync(this.work, { recursive: true, force: true });
    this.tmp = join(this.work, "TMPDIR");
    this.fakeHome = join(this.work, "FAKEHOME");
    mkdirSync(this.tmp, { recursive: true });
    mkdirSync(this.fakeHome, { recursive: true });
    mkdirSync(join(this.work, "logs"), { recursive: true });
  }

  rootPath(root: Root): string {
    return root === "home" ? this.home : root === "work" ? this.work : this.fakeHome;
  }

  /** Writes a file. Under the Harness Home it refuses to overwrite and removes the file in cleanup. */
  place(root: Root, path: string, content: string, mode?: number): string {
    const full = join(this.rootPath(root), path);
    if (root === "home") this.claimHomePath(full);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, mode ? { mode } : undefined);
    this.placed.push({ root, path, ...(content.length <= 3000 ? { content } : { content: `(${content.length} bytes, omitted)` }) });
    return full;
  }

  link(root: Root, path: string, target: string): string {
    const full = join(this.rootPath(root), path);
    if (root === "home") this.claimHomePath(full);
    mkdirSync(dirname(full), { recursive: true });
    symlinkSync(target, full);
    this.placed.push({ root, path, linkTo: target });
    return full;
  }

  mkdir(root: Root, path: string): string {
    const full = join(this.rootPath(root), path);
    if (root === "home") this.claimHomePath(full);
    mkdirSync(full, { recursive: true });
    this.placed.push({ root, path, mkdir: true });
    return full;
  }

  /** Runs `git init` in a folder under a root, so agy sees a git root there. */
  gitInit(root: Root, path: string): string {
    const full = join(this.rootPath(root), path);
    mkdirSync(full, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: full });
    this.placed.push({ root, path: path === "" ? "." : path, gitInit: true });
    return full;
  }

  /**
   * Registers a path under the Harness Home for removal in cleanup. Fails when the path exists, and when a part
   * that has to be created is not named `h1293-...` or one of the fixed names agy itself looks for.
   */
  private claimHomePath(full: string) {
    const fixedNames = ["GEMINI.md", "AGENTS.md", "skills.json", "skills", "rules", "global_workflows", "workflows", "plugins"];
    const rel = relative(this.home, full);
    let cur = this.home;
    let firstNew: string | undefined;
    let insideStaged = false;
    for (const part of rel.split("/")) {
      cur = join(cur, part);
      if (insideStaged) continue;
      if (this.homeCleanup.includes(cur)) { insideStaged = true; continue; }
      if (existsSync(cur) || pathIsLink(cur)) continue;
      firstNew = cur;
      if (!part.startsWith("h1293-") && !fixedNames.includes(part)) throw new Error(`refusing to stage ${rel} in the Harness Home: ${part} is not named h1293-...`);
      break;
    }
    if (existsSync(full) || pathIsLink(full)) throw new Error(`refusing to overwrite ${rel} in the Harness Home: it exists`);
    if (firstNew !== undefined) this.homeCleanup.push(firstNew);
  }

  /** Registers a Harness Home path that agy itself may create (named h1293-...) for removal in cleanup. */
  alsoRemoveFromHome(rel: string) {
    if (!rel.split("/").some((p) => p.startsWith("h1293-"))) throw new Error(`refusing to remove ${rel}: not named h1293-...`);
    this.homeCleanup.push(join(this.home, rel));
  }

  /** Places a test skill: a SKILL.md and the ref.txt it reads. Returns the skill folder. */
  placeSkill(root: Root, skillsDir: string, name: string, marker: string): string {
    this.place(root, `${skillsDir}/${name}/SKILL.md`, skillMd(name, marker));
    this.place(root, `${skillsDir}/${name}/ref.txt`, `REF-${marker}\n`);
    return join(this.rootPath(root), skillsDir, name);
  }

  /**
   * Builds a session skills folder the way the adapter does: library skills are real folders under
   * `skills/`, repository skills are links into a checkout under `repositories/<checkout>/skills/`, and
   * `.agents/skills/<name>` links to either one with a relative link. `gitFile` adds the empty `.git` file.
   * `sub` is the folder, relative to the work folder. Returns its absolute path.
   */
  stageSessionSkills(sub: string, opts: { lib?: Array<[name: string, marker: string]>; repo?: Array<{ checkout: string; name: string; target: string }>; gitFile?: boolean }): string {
    for (const [name, marker] of opts.lib ?? []) {
      this.placeSkill("work", `${sub}/skills`, name, marker);
      this.link("work", `${sub}/.agents/skills/${name}`, `../../skills/${name}`);
    }
    for (const r of opts.repo ?? []) {
      this.link("work", `${sub}/repositories/${r.checkout}/skills/${r.name}`, r.target);
      this.link("work", `${sub}/.agents/skills/${r.name}`, `../../repositories/${r.checkout}/skills/${r.name}`);
    }
    if (opts.gitFile) this.place("work", `${sub}/.git`, "");
    return join(this.work, sub);
  }

  /** A sorted listing of a folder tree: files, folders and links with their targets. `.git` folders are not entered. */
  list(dir: string): string[] {
    const out: string[] = [];
    const walk = (cur: string) => {
      if (!existsSync(cur)) return;
      for (const name of readdirSync(cur).sort()) {
        const full = join(cur, name);
        const rel = relative(dir, full);
        const st = lstatSync(full);
        if (st.isSymbolicLink()) out.push(`${rel} -> ${readlinkSync(full)}`);
        else if (st.isDirectory()) {
          if (name === ".git") out.push(`${rel}/ (git folder, not listed further)`);
          else { out.push(`${rel}/`); walk(full); }
        } else out.push(`${rel}${st.size === 0 ? " (empty file)" : ""}`);
      }
    };
    walk(dir);
    return out;
  }

  /**
   * Lists the folders now and returns a function that lists them again and stores both under
   * `observed.before` and `observed.after`, so a recording shows what agy wrote there.
   */
  watch(dirs: Record<string, string>): () => void {
    this.observed.before = this.snapshot(dirs);
    return () => { this.observed.after = this.snapshot(dirs); };
  }

  /** Sends a prompt and stores what came back under `observed.prompts` (prompt, reply, stop reason, permission requests). */
  async ask(agy: Agy, sessionId: string, text: string, timeoutMs = 90_000, extra: Record<string, unknown> = {}): Promise<PromptResult> {
    const r = await agy.prompt(sessionId, text, timeoutMs);
    const list = ((this.observed.prompts ??= []) as unknown[]);
    list.push({ process: agy.index, sessionId, prompt: text, reply: r.text, stopReason: r.stopReason, ...(r.error ? { error: r.error } : {}), timedOut: r.timedOut, permissionRequests: r.permissionRequests, ...extra });
    console.log(`  [${text.slice(0, 60).replace(/\n/g, " ")}] -> ${JSON.stringify(r.text.slice(0, 160))} stop=${r.stopReason} perms=${r.permissionRequests.length}`);
    return r;
  }

  /** Removes what this run staged in the Harness Home so far (used between two prompts of one session). */
  removeStagedHomeFiles() {
    for (const p of [...this.homeCleanup].reverse()) rmSync(p, { recursive: true, force: true });
    this.homeCleanup.length = 0;
  }

  /** Listings of several folders at once, keyed by a label. */
  snapshot(dirs: Record<string, string>): Record<string, string[]> {
    return Object.fromEntries(Object.entries(dirs).map(([label, dir]) => [label, this.list(dir)]));
  }

  readText(full: string): string | null {
    try { return readFileSync(full, "utf8"); } catch { return null; }
  }

  record(direction: "in" | "out", message: unknown) {
    this.lines.push(JSON.stringify({ t: Date.now() - this.t0, direction, message }));
  }

  /** The stored transcript of one of our sessions, as parsed lines. */
  transcript(sessionId: string): Msg[] {
    const file = join(this.home, "antigravity-acp/brain", sessionId, ".system_generated/logs/transcript.jsonl");
    const text = this.readText(file);
    if (text === null) return [{ missing: `no transcript for session ${sessionId}` }];
    return text.split("\n").filter((l) => l.trim() !== "").map((l) => { try { return JSON.parse(l); } catch { return { unparsable: l }; } });
  }

  /** The transcript lines that hold a user request (the prompt as stored, with agy's added notes). */
  userRequestLines(sessionId: string): Msg[] {
    return this.transcript(sessionId).filter((l) => JSON.stringify(l).includes("<USER_REQUEST>") || JSON.stringify(l).includes("missing"));
  }

  /** Starts one agy process. `geminiDir: false` leaves out --gemini-dir and --app-data-dir. */
  start(opts: { cwd: string; flags?: string[]; geminiDir?: boolean; dropXdg?: boolean }): Agy {
    const index = ++this.processCount;
    const logDir = mkdtempSync(join(this.work, "logs", "agy-"));
    const argv = [AGY_BINARY, "acp", "--process-per-session",
      ...(opts.geminiDir === false ? [] : ["--gemini-dir", this.home, "--app-data-dir", "antigravity-acp"]),
      "--log-file", join(logDir, "agy.log"), ...(opts.flags ?? [])];
    const env: Record<string, string> = {};
    const removed: string[] = [];
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (/^(GEMINI_|GOOGLE_|AGY_)/.test(k) || (opts.dropXdg && k.startsWith("XDG_") && k !== "XDG_RUNTIME_DIR")) { removed.push(k); continue; }
      env[k] = v;
    }
    Object.assign(env, { SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 0", AGY_CLI_DISABLE_AUTO_UPDATE: "true", TMPDIR: this.tmp, HOME: this.fakeHome });
    this.processNotes.push({
      process: index, argv, spawnCwd: opts.cwd,
      envNamesRemoved: removed.sort(), envNamesSet: ["SSH_CONNECTION", "AGY_CLI_DISABLE_AUTO_UPDATE", "TMPDIR", "HOME"],
    });
    this.lines.push(JSON.stringify({ note: { process: index, argv, spawnCwd: opts.cwd } }));
    mkdirSync(opts.cwd, { recursive: true });
    const child = Bun.spawn(argv, { cwd: opts.cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.children.push({ pid: child.pid, kill: () => { try { child.kill("SIGTERM"); } catch {} } });

    const messages: Msg[] = [];
    const waiting = new Map<number, (m: Msg) => void>();
    let nextId = 1;
    let reply = "";
    let permissions: PromptResult["permissionRequests"] = [];
    let commands: Array<{ name: string; description: string }> = [];
    let commandUpdates = 0;
    const send = (message: unknown) => {
      this.record("out", message);
      try { child.stdin.write(`${JSON.stringify(message)}\n`); child.stdin.flush(); } catch {}
    };
    const handle = (m: Msg) => {
      this.record("in", m);
      messages.push(m);
      if (m.method === undefined && m.id !== undefined) { waiting.get(m.id)?.(m); waiting.delete(m.id); return; }
      if (m.method === "session/update") {
        const u = m.params?.update;
        if (u?.sessionUpdate === "agent_message_chunk") reply += u.content?.text ?? "";
        if (u?.sessionUpdate === "available_commands_update") { commandUpdates++; commands = (u.availableCommands ?? []).map((c: Msg) => ({ name: c.name, description: c.description })); }
        return;
      }
      if (m.method === "session/request_permission" && m.id !== undefined) {
        const options = (m.params.options ?? []) as Array<{ kind: string; optionId: string }>;
        const wantKind = this.permissionPolicy.includes("allow_once") ? "allow_once" : "reject_once";
        const o = options.find((x) => x.kind === wantKind) ?? options[0];
        permissions.push({ kind: m.params.toolCall?.kind, title: m.params.toolCall?.title, decision: o?.kind ?? "none" });
        send({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "selected", optionId: o?.optionId } } });
        return;
      }
      if (m.method === "elicitation/create" && m.id !== undefined) { send({ jsonrpc: "2.0", id: m.id, result: { action: "decline" } }); return; }
      if (m.id !== undefined && m.method !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
    };
    const readers = [
      (async () => {
        let buf = "";
        for await (const chunk of child.stdout) {
          buf += new TextDecoder().decode(chunk, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
            if (line.trim() === "") continue;
            try { handle(JSON.parse(line)); } catch { this.record("in", { stdoutNotJson: line }); }
          }
        }
      })(),
      (async () => {
        let buf = "";
        for await (const chunk of child.stderr) {
          buf += new TextDecoder().decode(chunk, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) { this.record("in", { stderr: buf.slice(0, nl) }); buf = buf.slice(nl + 1); }
        }
        if (buf !== "") this.record("in", { stderr: buf });
      })(),
    ];
    const request = (method: string, params: unknown, timeoutMs = 120_000): Promise<Msg> => new Promise((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      send({ jsonrpc: "2.0", id, method, params });
      setTimeout(() => { if (waiting.delete(id)) resolve({ timeout: true }); }, timeoutMs);
    });
    let initialized = false;
    const ensureInitialized = async () => {
      if (initialized) return;
      initialized = true;
      const init = await request("initialize", { protocolVersion: 1, clientInfo: { name: "hercule-recorder", version: "0.0.0" },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } } });
      if (init.error || init.timeout) throw new Error(`initialize failed: ${JSON.stringify(init)}`);
      const auth = await request("authenticate", { methodId: "oauth-personal" });
      if (auth.error || auth.timeout) throw new Error(`authenticate failed (is the Harness Home signed in?): ${JSON.stringify(auth)}`);
    };
    // Waits until at least one available_commands_update arrived and none came for 1.5 seconds.
    const settleCommands = async (sinceUpdates: number) => {
      const until = Date.now() + 10_000;
      let seen = commandUpdates;
      let quietSince = Date.now();
      while (Date.now() < until) {
        await sleep(100);
        if (commandUpdates !== seen) { seen = commandUpdates; quietSince = Date.now(); }
        if (commandUpdates > sinceUpdates && Date.now() - quietSince > 1500) break;
      }
      return { sessionId: "", commands, commandUpdates: commandUpdates - sinceUpdates } as SessionInfo;
    };
    // The model and the mode are set right after the session opens, as Hercule's adapter does.
    const afterOpen = async (sessionId: string, mode: string | undefined, setModel: boolean) => {
      if (setModel) await request("session/set_config_option", { sessionId, configId: "model", value: MODEL });
      if (mode) await request("session/set_mode", { sessionId, modeId: mode });
      this.modes.push({ process: index, sessionId, mode: mode ?? "default (no set_mode)" });
    };
    const agy = {
      index,
      commands: () => commands,
      messageCount: () => messages.length,
      commandUpdateCount: () => commandUpdates,
      newSession: async ({ cwd, additionalDirectories, mode, model = true }) => {
        await ensureInitialized();
        const before = commandUpdates;
        const r = await request("session/new", { cwd, mcpServers: [], ...(additionalDirectories ? { additionalDirectories } : {}) });
        if (r.error || r.timeout) throw new Error(`session/new failed: ${JSON.stringify(r)}`);
        const sessionId = r.result.sessionId as string;
        this.sessionIds.push(sessionId);
        await afterOpen(sessionId, mode, model);
        const info = await settleCommands(before);
        return { ...info, sessionId };
      },
      resumeSession: async (sessionId, { cwd, additionalDirectories, mode }) => {
        await ensureInitialized();
        const before = commandUpdates;
        const r = await request("session/resume", { sessionId, cwd, mcpServers: [], ...(additionalDirectories ? { additionalDirectories } : {}) });
        if (r.error || r.timeout) throw new Error(`session/resume failed: ${JSON.stringify(r)}`);
        await afterOpen(sessionId, mode, true);
        const info = await settleCommands(before);
        return { ...info, sessionId };
      },
      prompt: async (sessionId, text, timeoutMs = 90_000) => {
        reply = ""; permissions = [];
        const pr = request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, timeoutMs + 20_000);
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } }); }, timeoutMs);
        const r = await pr;
        clearTimeout(timer);
        await sleep(800);
        return { text: reply, stopReason: r.result?.stopReason, error: r.error ?? (r.timeout ? "no reply" : undefined), timedOut, permissionRequests: permissions };
      },
      close: async () => {
        try { child.kill("SIGTERM"); } catch {}
        const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000);
        await child.exited;
        clearTimeout(killer);
        await Promise.all(readers);
      },
    } as Agy;
    agy.rawRequest = request;
    agy.initializeAndAuthenticate = async () => {
      initialized = true;
      const init = await request("initialize", { protocolVersion: 1, clientInfo: { name: "hercule-recorder", version: "0.0.0" }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } } });
      const auth = await request("authenticate", { methodId: "oauth-personal" });
      return { init, auth };
    };
    return agy;
  }

  /** Removes what this run staged in the Harness Home and what its own sessions stored there. */
  cleanupHome() {
    for (const p of [...this.homeCleanup].reverse()) rmSync(p, { recursive: true, force: true });
    for (const id of this.sessionIds) {
      const app = join(this.home, "antigravity-acp");
      rmSync(join(app, "brain", id), { recursive: true, force: true });
      rmSync(join(app, "annotations", `${id}.pbtxt`), { force: true });
      rmSync(join(app, "implicit", `${id}.pb`), { force: true });
      const conv = join(app, "conversations");
      if (existsSync(conv)) for (const f of readdirSync(conv)) if (f.startsWith(`${id}.db`)) rmSync(join(conv, f), { force: true });
    }
  }

  /** Names under the Harness Home that carry the staging prefix: must be empty after cleanup. */
  leftovers(): string[] {
    const out: string[] = this.homeCleanup.filter((p) => existsSync(p) || pathIsLink(p)).map((p) => relative(this.home, p));
    const walk = (dir: string, depth: number) => {
      if (depth > 4 || !existsSync(dir)) return;
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (name.startsWith("h1293-")) out.push(relative(this.home, full));
        else if (lstatSync(full).isDirectory() && !["brain", "conversations", "cache", "builtin", "bin", "implicit", "annotations"].includes(name)) walk(full, depth + 1);
      }
    };
    walk(this.home, 0);
    return out;
  }

  /** Writes the recording. Hides the Linux user name everywhere, also when agy streamed it in several chunks. */
  write(failure?: string) {
    const files = this.placed;
    const noteFirst = {
      scenario: this.name,
      binary: "agy 1.5.15 (agentInfo.version in the initialize reply)",
      roots: { home: "the Harness Home (a signed-in copy, shared with other sessions)", work: this.work, fakehome: this.fakeHome, TMPDIR: this.tmp },
      model: MODEL,
      mode: this.modes,
      TMPDIR: this.tmp,
      permissionPolicy: this.permissionPolicy,
      processes: this.processNotes,
      filesPlaced: files,
      ...this.note,
    };
    const trailer = { note: { observed: { ...this.observed, harnessHomeLeftoverStagingNames: this.leftovers(), ...(failure ? { failure } : {}) } } };
    const messageLines = fixSplitName(this.lines, USER_NAME);
    const all = [JSON.stringify({ note: noteFirst }), ...messageLines, JSON.stringify(trailer)];
    const text = hideUserName(all.join("\n") + "\n");
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, `${this.name}.jsonl`), text);
    const hits = (text.match(new RegExp(USER_NAME, "gi")) ?? []).length;
    if (hits > 0) throw new Error(`the user name is still in ${this.name}.jsonl (${hits} hits)`);
  }

  async stopAll() {
    for (const c of this.children) c.kill();
  }
}

const pathIsLink = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

/** Names of the non-built-in entries of a command list: the test skills (h1293-...) and `grill-me`. */
export const testSkills = (commands: Array<{ name: string; description: string }>) =>
  commands.filter((c) => c.name.startsWith("h1293-") || c.name === "grill-me");

const hideUserName = (text: string): string => text.replace(new RegExp(USER_NAME, "gi"), "user");

/**
 * When agy streams a text in chunks, the user name can be split over two chunks. This joins each run of
 * chunks of one kind, and where the name straddles a chunk border, removes it in both pieces.
 */
const fixSplitName = (lines: string[], name: string): string[] => {
  const parsed = lines.map((l) => JSON.parse(l));
  const isChunk = (e: Msg) => e.direction === "in" && e.message?.method === "session/update" &&
    ["agent_message_chunk", "agent_thought_chunk"].includes(e.message.params?.update?.sessionUpdate) && typeof e.message.params.update.content?.text === "string";
  const kind = (e: Msg) => e.message.params.update.sessionUpdate;
  let i = 0;
  while (i < parsed.length) {
    if (!isChunk(parsed[i])) { i++; continue; }
    let j = i;
    while (j + 1 < parsed.length && isChunk(parsed[j + 1]) && kind(parsed[j + 1]) === kind(parsed[i])) j++;
    const run = parsed.slice(i, j + 1);
    const texts: string[] = run.map((e) => e.message.params.update.content.text);
    const whole = texts.join("");
    const re = new RegExp(name, "gi");
    let m: RegExpExecArray | null;
    const bounds: number[] = [];
    let acc = 0;
    for (const t of texts) { bounds.push(acc); acc += t.length; }
    const owner = (pos: number) => { let k = 0; while (k + 1 < bounds.length && bounds[k + 1] <= pos) k++; return k; };
    const cuts: Array<[number, number]> = [];
    while ((m = re.exec(whole)) !== null) {
      if (owner(m.index) !== owner(m.index + m[0].length - 1)) cuts.push([m.index, m.index + m[0].length]);
    }
    if (cuts.length > 0) {
      // Replace the straddling name by "user" in the chunk where it starts and cut its letters from the next chunks.
      const chars = whole.split("");
      for (const [a, b] of cuts) { for (let p = a; p < b; p++) chars[p] = ""; chars[a] = "user"; }
      const fixed = chars;
      run.forEach((e, k) => {
        const from = bounds[k]!;
        e.message.params.update.content.text = fixed.slice(from, from + texts[k]!.length).join("");
      });
    }
    i = j + 1;
  }
  return parsed.map((e) => JSON.stringify(e));
};

/** Runs a scenario: always cleans the Harness Home, always writes the recording (with the failure, if any). */
export const runScenario = async (name: string, shows: string, body: (run: Run) => Promise<void>) => {
  const run = new Run(name);
  run.note.shows = shows;
  let failure: string | undefined;
  const hard = setTimeout(() => { console.log(`${name}: HARD TIMEOUT`); void run.stopAll().then(() => process.exit(1)); }, 900_000);
  const onSignal = () => { void run.stopAll(); run.cleanupHome(); process.exit(130); };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    await body(run);
  } catch (e) {
    failure = (e as Error).stack ?? String(e);
    console.log(`${name}: FAILED ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    clearTimeout(hard);
    await run.stopAll();
    await sleep(1500);
    run.cleanupHome();
    run.write(failure);
    console.log(`${name}: recording written${failure ? " (with failure)" : ""}`);
  }
  // Pending request timers would keep the process alive.
  process.exit(process.exitCode ?? 0);
};

export const names = (commands: Array<{ name: string }>) => commands.map((c) => c.name);
