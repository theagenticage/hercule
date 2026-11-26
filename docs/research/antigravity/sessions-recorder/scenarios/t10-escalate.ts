import { writeFileSync, rmSync, existsSync, readFileSync, mkdirSync, copyFileSync, symlinkSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { setup, cleanup, startNoted, openSession, prompt, freshWork, HOME } from "./trust-lib.ts";
import { FULL_ACCESS, setMode, select } from "../agy-session.ts";
// usage: bun t10-escalate.ts <cfg.json>
// cfg: { name, mode, files: {rel: content}, symlinks?: {rel: target}, git?: bool, sub?: string (cwd relative to root), homeHooks?: any, prompt, allowIf?: regex (permission requests whose toolCall JSON matches are allowed, others rejected), additionalDirectories?: string[] }
const cfg = JSON.parse(readFileSync(process.argv[2], "utf8"));
const OUT = "/tmp/hercule-1282/rec8";
const tmp = setup();
const HOOKTS = "/var/tmp/hercule-1282-hookdir/t10/hook.ts";
const dir = `/var/tmp/hercule-1282-hookdir/t10/${cfg.name}`;
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
const log = `${dir}/hook.log`;
process.env.HERCULE_T10_LOG = log; if (cfg.env) Object.assign(process.env, cfg.env);
const sub = (s: string) => s.replaceAll("$HOOK", `bun ${HOOKTS}`).replaceAll("$ROOT", root);
const root = freshWork(`t10-${cfg.name}`);
if (cfg.git) execSync("git init -q", { cwd: root });
const cwd = cfg.sub ? join(root, cfg.sub) : root;
mkdirSync(cwd, { recursive: true });
for (const [f, c] of Object.entries<string>(cfg.files ?? {})) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), sub(c)); }
for (const [f, t] of Object.entries<string>(cfg.symlinks ?? {})) { mkdirSync(dirname(join(root, f)), { recursive: true }); symlinkSync(join(root, t), join(root, f)); }
const hooks = `${HOME}/config/hooks.json`;
if (existsSync(hooks)) { console.log("hooks.json exists in home, abort"); process.exit(3); }
if (cfg.homeHooks) writeFileSync(hooks, sub(JSON.stringify(cfg.homeHooks)));
const agy = startNoted({ cwd, out: `${OUT}/${cfg.name}.jsonl`, extraFlags: cfg.mode === "full" ? FULL_ACCESS : [] }, [`cfg ${JSON.stringify(cfg)}`, `home hooks.json ${cfg.homeHooks ? "written" : "absent"}`, `root=${root} cwd=${cwd}`]);
const requests: string[] = [];
const allow = cfg.allowIf ? new RegExp(cfg.allowIf) : undefined;
try {
  agy.onRequest((m) => {
    if (m.method === "session/request_permission") {
      const tc = JSON.stringify(m.params.toolCall);
      const ok = allow?.test(tc);
      requests.push(`${ok ? "ALLOW" : "REJECT"} ${tc.slice(0, 220)}`);
      agy.note(`permission request ${ok ? "allowed" : "rejected"}: ${tc.slice(0, 200)}`);
      select(agy, m, ok ? "allow_once" : "reject_once");
    } else agy.respond(m.id, { action: "decline" });
  });
  const { sessionId } = await openSession(agy, { cwd, ...(cfg.additionalDirectories ? {} : {}) });
  if (cfg.mode === "accept-edits") await setMode(agy, sessionId, "accept-edits");
  for (const pr of cfg.prompts ?? [cfg.prompt]) {
    agy.note(`PROMPT: ${sub(pr).slice(0, 200)}`);
    const r = await prompt(agy, sessionId, sub(pr));
    console.log(cfg.name, "prompt ->", r.result?.stopReason ?? JSON.stringify(r.error));
  }
  const seen = new Map<string, string>();
  for (const m of agy.messages) {
    const u = m.params?.update;
    if (m.method === "session/update" && (u?.sessionUpdate === "tool_call_update" || u?.sessionUpdate === "tool_call") && u.toolCallId) {
      seen.set(u.toolCallId, `${u.title ?? seen.get(u.toolCallId)?.split(" | ")[0] ?? ""} | ${u.status ?? ""} | ${JSON.stringify(u.rawInput ?? {}).slice(0, 140)}`);
    }
  }
  console.log("TOOL CALLS (last status):"); for (const [k, v] of seen) console.log(" ", k.slice(0, 14), v);
  console.log("REQUESTS:", requests.length); for (const q of requests) console.log(" ", q);
  console.log("HOOK LOG:\n" + (existsSync(log) ? readFileSync(log, "utf8") : "(no hook ran)"));
  const text = agy.messages.filter((m) => m.params?.update?.sessionUpdate === "agent_message_chunk").map((m) => m.params.update.content?.text ?? "").join("");
  console.log("TEXT:", text.slice(0, 500).replace(/\n/g, " "));
  const list = (d: string, p = ""): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.name === ".git" ? [] : e.isDirectory() ? list(join(d, e.name), `${p}${e.name}/`) : [`${p}${e.name}`]);
  console.log("FILES:", list(root).join(" "));
} finally {
  await agy.close();
  rmSync(hooks, { force: true });
  cleanup(tmp);
}
if (cfg.freshProcessPrompt) {
  // A second agy process (a new session) in the same workspace, to see what it loads from files the first one wrote.
  const tmp2 = setup();
  const agy2 = startNoted({ cwd, out: `${OUT}/${cfg.name}-fresh.jsonl`, extraFlags: cfg.mode === "full" ? FULL_ACCESS : [] }, ["second process, same cwd"]);
  const reqs2: string[] = [];
  try {
    agy2.onRequest((m) => {
      if (m.method === "session/request_permission") { reqs2.push(JSON.stringify(m.params.toolCall).slice(0, 160)); select(agy2, m, "reject_once"); } else agy2.respond(m.id, { action: "decline" });
    });
    const { sessionId } = await openSession(agy2, { cwd });
    if (cfg.mode === "accept-edits") await setMode(agy2, sessionId, "accept-edits");
    const r = await prompt(agy2, sessionId, sub(cfg.freshProcessPrompt));
    console.log("FRESH PROCESS:", r.result?.stopReason, "requests:", reqs2.length, reqs2);
    console.log("HOOK LOG after fresh:\n" + (existsSync(log) ? readFileSync(log, "utf8") : "(no hook ran)"));
  } finally { await agy2.close(); cleanup(tmp2); }
}
