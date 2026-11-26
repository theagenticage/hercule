// MCP experiments: stand-ins, placed files, a canary bearer, a note line, a summary of tool activity.
import { mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync, existsSync, copyFileSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { startAgy, openSession, prompt, autoPermission, sleep, isUpdate, setMode, FULL_ACCESS, type Agy } from "./agy-session.ts";

export const HOME = "/tmp/hercule-1282/homes/neon";
export const REC = "/tmp/hercule-1282/rec7";
export const WORK = process.env.WORKROOT ?? "/var/tmp/hercule-1282-work";
export const TMPBASE = "/var/tmp/hercule-1282-tmp7";
export const HOME_MCP = `${HOME}/config/mcp_config.json`;
export const HOME_MCP_BACKUP = "/tmp/hercule-1282/mcp-standin/mcp_config.json.orig";
export const CANARIES = "/tmp/hercule-1282/mcp-standin/canaries.txt";

export const canary = () => { const c = `canary-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`; appendFileSync(CANARIES, c + "\n"); return c; };

export interface Standin { name: string; port: number; url: string; log: string; ctl(o: object): Promise<any>; stop(): Promise<void>; }
export const startStandin = async (name: string, port: number, log: string, fresh = true): Promise<Standin> => {
  mkdirSync(dirname(log), { recursive: true });
  if (fresh) writeFileSync(log, "");
  const child = Bun.spawn(["bun", "/tmp/hercule-1282/mcp-standin/server.ts", String(port), name, log], { stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/__ctl`, { method: "POST", body: "{}" }); break; } catch { await sleep(100); } }
  return {
    name, port, log, url: `http://127.0.0.1:${port}/mcp`,
    ctl: async (o) => (await fetch(`http://127.0.0.1:${port}/__ctl`, { method: "POST", body: JSON.stringify(o) })).json(),
    stop: async () => { child.kill("SIGTERM"); await child.exited; },
  };
};
export const readLog = (log: string) => readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
export const requestsOf = (log: string) => readLog(log).filter((r) => r.rpc !== undefined).map((r) => `${r.http} ${r.rpc}${r.tool ? `(${r.tool})` : ""} auth=${r.auth ?? "-"} sid=${r.sid ? "yes" : "-"}`);

export const mcpServer = (name: string, url: string, token: string | null) => ({ type: "http", name, url, headers: token ? [{ name: "Authorization", value: `Bearer ${token}` }] : [] });
export const fileEntry = (name: string, url: string, token: string | null) => JSON.stringify({ mcpServers: { [name]: { serverUrl: url, ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) } } }, null, 2);

export const placeFiles = (root: string, files: Record<string, string>) => { for (const [f, c] of Object.entries(files)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), c); } };

export const backupHomeMcp = () => { if (!existsSync(HOME_MCP_BACKUP)) copyFileSync(HOME_MCP, HOME_MCP_BACKUP); };
export const restoreHomeMcp = () => { if (existsSync(HOME_MCP_BACKUP)) { Bun.spawnSync(["cp", "-p", HOME_MCP_BACKUP, HOME_MCP]); } };

export interface Cfg {
  name: string; root?: string;
  files?: Record<string, string>; // relative to the run root
  cwdRel?: string; git?: string[]; // relative paths to `git init`
  fakeHome?: boolean; homeMcp?: string; flags?: string[];
  noteExtra?: Record<string, unknown>; mcpServers: any[];
}
export interface Ctx { agy: Agy; cwd: string; root: string; tmp: string; sessionId: string; sub: (i: number) => any[]; cfg: Cfg; }

/** Short summary of tool activity in messages from index `from`. */
export const toolSummary = (agy: Agy, from = 0): string[] => {
  const out: string[] = [];
  for (const m of agy.messages.slice(from)) {
    const u = m.params?.update;
    if (m.method === "session/update" && (u?.sessionUpdate === "tool_call" || u?.sessionUpdate === "tool_call_update")) {
      const c = JSON.stringify(u.content ?? u.rawOutput ?? "").slice(0, 160);
      out.push(`${u.sessionUpdate} id=${String(u.toolCallId).slice(0, 8)} kind=${u.kind ?? "-"} status=${u.status ?? "-"} title=${JSON.stringify(u.title ?? "")} content=${c}`);
    } else if (m.method === "session/request_permission") {
      out.push(`PERMISSION ${JSON.stringify(m.params?.toolCall?.title)} kind=${m.params?.toolCall?.kind} opts=${(m.params?.options ?? []).map((o: any) => o.kind).join(",")}`);
    }
  }
  return out;
};
export const agentText = (agy: Agy, from = 0) => agy.messages.slice(from).filter((m) => m.method === "session/update" && m.params?.update?.sessionUpdate === "agent_message_chunk").map((m) => m.params.update.content?.text ?? "").join("");

export const exp = async (cfg: Cfg, body: (c: Ctx) => Promise<void>, opts: { resumeId?: string; append?: boolean; keep?: boolean } = {}) => {
  const root = cfg.root ?? `${WORK}/${cfg.name}`;
  if (!opts.append && !opts.resumeId) rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  placeFiles(root, cfg.files ?? {});
  for (const g of cfg.git ?? []) { mkdirSync(join(root, g), { recursive: true }); Bun.spawnSync(["git", "init", "-q", join(root, g)]); }
  const cwd = join(root, cfg.cwdRel ?? "");
  mkdirSync(cwd, { recursive: true });
  const tmp = mkdtempSync(join(TMPBASE, `${cfg.name}-`));
  const fakeHome = join(root, "fakehome");
  const prev = { TMPDIR: process.env.TMPDIR, HOME: process.env.HOME, WORKROOT: process.env.WORKROOT };
  process.env.TMPDIR = tmp; process.env.WORKROOT = WORK;
  if (cfg.fakeHome) { mkdirSync(fakeHome, { recursive: true }); process.env.HOME = fakeHome; }
  let touchedHome = false;
  if (cfg.homeMcp !== undefined) { backupHomeMcp(); writeFileSync(HOME_MCP, cfg.homeMcp); touchedHome = true; }
  const out = `${REC}/${cfg.name}.jsonl`;
  const agy = startAgy({ home: HOME, cwd, out, append: opts.append, extraFlags: cfg.flags });
  try {
    const scrub = (s: any[]) => JSON.parse(JSON.stringify(s).replace(/canary-[0-9a-f]{16}/g, "<canary>"));
    agy.note({
      argv: ["agy", "acp", "--process-per-session", "--gemini-dir", HOME, "--app-data-dir", "antigravity-acp", ...(cfg.flags ?? [])],
      TMPDIR: tmp, cwd, filesPlaced: Object.keys(cfg.files ?? {}).map((f) => join(root, f)), HOME_env: process.env.HOME,
      homeFiles: cfg.homeMcp !== undefined ? { [HOME_MCP]: JSON.parse(JSON.stringify(cfg.homeMcp).replace(/canary-[0-9a-f]{16}/g, "<canary>")) } : {},
      mcpServers: scrub(cfg.mcpServers), ...cfg.noteExtra,
    } as any);
    autoPermission(agy);
    const opened = await openSession(agy, { cwd, mcpServers: cfg.mcpServers, resumeId: opts.resumeId });
    await body({ agy, cwd, root, tmp, sessionId: opened.sessionId, sub: (i) => toolSummary(agy, i), cfg });
  } catch (e) { console.log(`${cfg.name}: FAILED ${(e as Error).message}`); }
  finally {
    await agy.close();
    if (touchedHome) restoreHomeMcp();
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete (process.env as any)[k]; else (process.env as any)[k] = v; }
    if (!opts.keep && !process.env.KEEPTMP) { /* keep TMPDIR for the token grep (step 8) */ }
  }
};

export const ASK_LIST = "List the names of your MCP tools, one per line. Reply NONE if you have none.";
export const ASK_CALL = "Call your MCP tool named whoami now and quote its result in one line. If you have no such tool, reply NO TOOL.";
export const turn = async (c: Ctx, text: string, timeout = 150_000) => {
  const from = c.agy.messages.length;
  const r = await Promise.race([prompt(c.agy, c.sessionId, text), sleep(timeout).then(() => ({ result: { stopReason: "TIMEOUT" } }))]) as any;
  console.log(`  [${c.cfg.name}] "${text.slice(0, 40)}" -> ${r.error ? JSON.stringify(r.error) : r.result?.stopReason}`);
  for (const l of toolSummary(c.agy, from)) console.log(`    ${l}`);
  console.log(`    text: ${JSON.stringify(agentText(c.agy, from).slice(0, 300))}`);
  return { reply: r, from };
};
