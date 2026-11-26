// Scenario runner for #1283 with a file watcher on the conversation's .system_generated tree and its children.
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { startAgy, openSession, type Agy, AGY_BINARY } from "./agy-session.ts";

export const HOME = "/tmp/hercule-1282/homes/neon";
export const BRAIN = `${HOME}/antigravity-acp/brain`;
export const REC = "/tmp/hercule-1283/rec";
export const WORK = "/var/tmp/hercule-1283-work";

export const maskLong = (s: string) => s.replace(/[^\s"\\]{201,}/g, "<long>");
const maskValue = (v: any): any =>
  typeof v === "string" ? (v.length > 200 && !/\s/.test(v) ? "<long>" : v) : Array.isArray(v) ? v.map(maskValue) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskValue(x)])) : v;
export const maskJsonText = (text: string): string => {
  try { return JSON.stringify(maskValue(JSON.parse(text))); } catch { return maskLong(text); }
};
export const maskLine = (line: string): any => {
  try { return maskValue(JSON.parse(line)); } catch { return { unparsable: maskLong(line) }; }
};

interface FileState { ino: number; size: number; buf: Buffer; consumed: number }

const walk = (dir: string, out: string[] = []): string[] => {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
};

export interface Watcher { stop(): void; ids: Set<string> }

/** Polls every 100 ms the .system_generated trees of `rootId` and of every child found in subagents/*.json. */
export const startWatcher = (agy: Agy, rootId: string, outFile: string): Watcher => {
  writeFileSync(outFile, "");
  const ids = new Set<string>([rootId]);
  const states = new Map<string, FileState>();
  const seen = new Set<string>();
  let stopped = false;
  const emit = (o: any) => appendFileSync(outFile, `${JSON.stringify({ t: Date.now() - agy.started, ...o })}\n`);
  const lines = (text: string) => { const parts = text.split("\n"); const tail = parts.pop()!; return { complete: parts.filter((l) => l !== ""), tail }; };

  const pollOnce = () => {
    const now = Date.now() - agy.started;
    seen.clear();
    for (const id of [...ids]) {
      const root = join(BRAIN, id, ".system_generated");
      for (const f of walk(root)) {
        const rel = relative(BRAIN, f);
        seen.add(rel);
        let st; try { st = statSync(f); } catch { continue; }
        const prev = states.get(rel);
        if (prev && prev.size === st.size && prev.ino === st.ino) {
          // same size: still compare content cheaply for small files (a rewrite with equal size)
          if (st.size > 1_000_000) continue;
        }
        let buf: Buffer; try { buf = readFileSync(f); } catch { continue; }
        const isJsonl = f.endsWith(".jsonl"), isJson = f.endsWith(".json");
        if (f.includes("/subagents/") && isJson) {
          const child = f.split("/").pop()!.replace(/\.json$/, "");
          if (!ids.has(child)) { ids.add(child); }
        }
        if (prev && prev.ino === st.ino && buf.length === prev.size && buf.equals(prev.buf)) continue;
        let event: string;
        if (!prev) event = "created";
        else if (prev.ino !== st.ino || buf.length < prev.size || !buf.subarray(0, prev.size).equals(prev.buf)) event = "rewritten";
        else event = "grew";
        const rec: any = { path: rel, event, size: buf.length };
        let consumed = 0;
        if (isJsonl) {
          const from = event === "grew" ? prev!.consumed : 0;
          const { complete, tail } = lines(sliceFromByte(buf, from));
          rec.newLines = complete.map(maskLine);
          if (tail) { rec.partialTail = true; rec.partialTailBytes = Buffer.byteLength(tail); }
          consumed = buf.length - Buffer.byteLength(tail);
        } else if (isJson) {
          rec.content = (() => { try { return maskValue(JSON.parse(buf.toString("utf8"))); } catch { return { unparsable: maskLong(buf.toString("utf8")).slice(0, 2000) }; } })();
        }
        states.set(rel, { ino: st.ino, size: buf.length, buf, consumed });
        emit(rec);
      }
    }
    for (const rel of [...states.keys()]) {
      if (!seen.has(rel)) { const s = states.get(rel)!; states.delete(rel); emit({ path: rel, event: "deleted", size: s.size }); }
    }
    void now;
  };
  const timer = setInterval(() => { if (!stopped) { try { pollOnce(); } catch (e) { emit({ watcherError: String(e) }); } } }, 100);
  return { ids, stop() { if (stopped) return; try { pollOnce(); } catch {} stopped = true; clearInterval(timer); } };
};
const sliceFromByte = (buf: Buffer, from: number) => buf.subarray(from).toString("utf8");

/** Copies the final .system_generated trees to rec/<name>.brain/<id>/, masking json and jsonl files. */
export const copyBrains = (name: string, ids: Iterable<string>) => {
  const dest = `${REC}/${name}.brain`;
  rmSync(dest, { recursive: true, force: true });
  for (const id of ids) {
    const src = join(BRAIN, id, ".system_generated");
    if (!existsSync(src)) continue;
    for (const f of walk(src)) {
      const to = join(dest, id, relative(src, f));
      mkdirSync(join(to, ".."), { recursive: true });
      if (f.endsWith(".jsonl")) writeFileSync(to, readFileSync(f, "utf8").split("\n").map((l) => (l === "" ? l : JSON.stringify(maskLine(l)))).join("\n"));
      else if (f.endsWith(".json")) writeFileSync(to, maskJsonText(readFileSync(f, "utf8")));
      else cpSync(f, to);
    }
  }
};

export interface Ctx { cwd: string; sessionId: string; out: string; watcher: Watcher; home: string; name: string }

export const run1283 = async (
  name: string,
  o: { files?: Record<string, string>; flags?: string[]; proxy?: { url: string }; mode?: string; hookLog?: string },
  body: (agy: Agy, ctx: Ctx) => Promise<string>,
) => {
  process.env.TMPDIR = `${WORK}/tmp-${name}`;
  mkdirSync(process.env.TMPDIR, { recursive: true });
  const cwd = `${WORK}/${name}`;
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(cwd, { recursive: true });
  for (const [f, c] of Object.entries(o.files ?? {})) writeFileSync(join(cwd, f), c);
  mkdirSync(REC, { recursive: true });
  const out = `${REC}/${name}.jsonl`;
  const extraFlags = o.flags ?? [];
  const agy = startAgy({ home: HOME, cwd, out, extraFlags, proxy: o.proxy });
  const version = Bun.spawnSync([AGY_BINARY, "--version"]).stdout.toString().trim();
  agy.note(`SETUP: argv=${JSON.stringify([AGY_BINARY, "acp", "--process-per-session", "--gemini-dir", HOME, "--app-data-dir", "antigravity-acp", "--log-file", "<tmp>", ...extraFlags])} TMPDIR=${process.env.TMPDIR} cwd=${cwd} files=${JSON.stringify(Object.keys(o.files ?? {}))} agyVersion=${version} accessMode=${o.mode ?? (extraFlags.includes("--dangerously-skip-permissions") ? "full-access (--dangerously-skip-permissions)" : "default (approval required)")} proxy=${Boolean(o.proxy)} hookLog=${o.hookLog ?? "none"}`);
  let watcher: Watcher | undefined;
  const timer = setTimeout(() => { console.log(`${name}: HARD TIMEOUT 600s`); watcher?.stop(); void agy.close().then(() => process.exit(1)); }, 600_000);
  try {
    const { sessionId } = await openSession(agy, { cwd });
    agy.note(`conversation id (sessionId) = ${sessionId}`);
    watcher = startWatcher(agy, sessionId, `${REC}/${name}.files.jsonl`);
    console.log(await body(agy, { cwd, sessionId, out, watcher, home: HOME, name }));
  } catch (e) {
    console.log(`${name}: FAILED ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    watcher?.stop();
    await agy.close();
    if (watcher) { copyBrains(name, watcher.ids); console.log(`${name}: conversation ids: ${[...watcher.ids].join(" ")}`); }
  }
};

/** True when any message in the recording mentions a quota or rate-limit error. */
export const quotaHit = (agy: Agy) => agy.messages.some((m) => /Individual quota|quota (reached|exceeded)|RESOURCE_EXHAUSTED|"code":429|status[ =:]429/i.test(JSON.stringify(m)));
