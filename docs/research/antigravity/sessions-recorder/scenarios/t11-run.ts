import { writeFileSync, rmSync, existsSync, readFileSync, mkdirSync, symlinkSync, readdirSync, cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { startAgy, openSession, prompt, select, setMode } from "./t11-session.ts";
// usage: bun t11-run.ts <cfg.json>
// cfg: { name, mode?, model?, listModels?, files, symlinks, git, prompts[], allowIf?, deny?(regex on args), noHook?, wait? }
const cfg = JSON.parse(readFileSync(process.argv[2], "utf8"));
const S = "/var/tmp/hercule-1282-t11", HOME = `${S}/home`, OUT = "/tmp/hercule-1282/rec11";
const root = `${S}/work/${cfg.name}`;
rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true });
const hookLog = `${OUT}/${cfg.name}.hook.log`; rmSync(hookLog, { force: true });
process.env.HERCULE_T11_LOG = hookLog; if (cfg.deny) process.env.HERCULE_T11_DENY = cfg.deny;
const sub = (s: string) => s.replaceAll("$ROOT", root).replaceAll("$S", S);
if (cfg.git !== false) execSync("git init -q", { cwd: root });
for (const [f, c] of Object.entries<string>(cfg.files ?? {})) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), sub(c)); }
for (const [f, t] of Object.entries<string>(cfg.symlinks ?? {})) { mkdirSync(dirname(join(root, f)), { recursive: true }); symlinkSync(sub(t), join(root, f)); }
const hooks = `${HOME}/config/hooks.json`;
if (existsSync(hooks)) { console.log("hooks.json exists, abort"); process.exit(3); }
if (!cfg.noHook) writeFileSync(hooks, JSON.stringify({ h: { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: `bun ${S}/hook/hook.ts` }] }] } }));
const out = `${OUT}/${cfg.name}.jsonl`;
const agy = startAgy({ home: HOME, cwd: root, out, extraFlags: cfg.mode === "full" ? ["--dangerously-skip-permissions"] : [] });
const requests: string[] = [];
const allow = cfg.allowIf ? new RegExp(cfg.allowIf) : undefined;
try {
  agy.onRequest((m) => {
    if (m.method === "session/request_permission") {
      const tc = JSON.stringify(m.params.toolCall); const ok = allow?.test(tc);
      requests.push(`${ok ? "ALLOW" : "REJECT"} ${tc.slice(0, 260)}`);
      select(agy, m, ok ? "allow_once" : "reject_once");
    } else agy.respond(m.id, { action: "decline" });
  });
  const { sessionId, session } = await openSession(agy, { cwd: root });
  if (cfg.listModels) console.log("CONFIG OPTIONS:", JSON.stringify(session.result.configOptions).replace(/[\w.+-]+@[\w.-]+/g, "<email>"));
  if (cfg.model) { const r = await agy.request("session/set_config_option", { sessionId, configId: "model", value: cfg.model }); console.log("set model", cfg.model, r.error ? JSON.stringify(r.error) : "ok"); }
  if (cfg.mode && cfg.mode !== "full" && cfg.mode !== "default") await setMode(agy, sessionId, cfg.mode);
  for (const pr of cfg.prompts ?? []) {
    agy.note(`PROMPT: ${sub(pr)}`);
    const p = prompt(agy, sessionId, sub(pr));
    const r: any = await Promise.race([p, new Promise((res) => setTimeout(() => res({ result: { stopReason: "TIMEOUT 240s" } }), 240_000))]);
    console.log(cfg.name, "prompt ->", r.result?.stopReason ?? JSON.stringify(r.error));
  }
  if (cfg.wait) await new Promise((r) => setTimeout(r, cfg.wait));
  const seen = new Map<string, string>();
  for (const m of agy.messages) {
    const u = m.params?.update;
    if (m.method === "session/update" && (u?.sessionUpdate === "tool_call_update" || u?.sessionUpdate === "tool_call") && u.toolCallId)
      seen.set(u.toolCallId, `${u.title ?? seen.get(u.toolCallId)?.split(" | ")[0] ?? ""} | ${u.status ?? ""} | ${JSON.stringify(u.rawInput ?? {}).slice(0, 200)}`);
  }
  console.log("TOOL CALLS (last status):"); for (const [k, v] of seen) console.log(" ", k.slice(0, 12), v);
  console.log("REQUESTS:", requests.length); for (const q of requests) console.log(" ", q);
  console.log("HOOK LOG:\n" + (existsSync(hookLog) ? readFileSync(hookLog, "utf8").split("\n").map((l) => l.slice(0, 700)).join("\n") : "(no hook ran)"));
  const text = agy.messages.filter((m) => m.params?.update?.sessionUpdate === "agent_message_chunk").map((m) => m.params.update.content?.text ?? "").join("");
  console.log("TEXT:", text.slice(0, 500).replace(/\n/g, " "));
  const list = (d: string, p = ""): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.name === ".git" ? [] : e.isDirectory() ? list(join(d, e.name), `${p}${e.name}/`) : [`${p}${e.name}`]);
  console.log("FILES:", list(root).join(" "));
} finally { await agy.close(); rmSync(hooks, { force: true }); process.exit(0); }
