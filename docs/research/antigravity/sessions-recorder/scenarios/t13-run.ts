import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { startAgy, openSession, prompt, select } from "./t13-session.ts";
// usage: bun t13-run.ts <name> <prompt>   (env: T13_PATH optional)
// Measures what the home PreToolUse hook sees when the browser subagent starts. Mode default, Gemini 3.8 Flash, rejects every permission request.
const [name, userPrompt] = process.argv.slice(2);
const S = "/var/tmp/hercule-1282-t13", HOME = `${S}/home`, OUT = "/tmp/hercule-1282/rec13";
const root = `${S}/work/${name}`;
rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true });
execSync("git init -q", { cwd: root });
const hookLog = `${S}/${name}.hook.log`; rmSync(hookLog, { force: true }); writeFileSync(hookLog, "");
process.env.HERCULE_T13_LOG = hookLog; process.env.T13_AGYLOG = `${S}/${name}.agy.log`;
const agy = startAgy({ home: HOME, cwd: root, out: `${OUT}/${name}.jsonl` });
const requests: string[] = [];
const t0 = () => Date.now();
agy.onRequest((m) => {
  if (m.method === "session/request_permission") { requests.push(`${t0()} REJECT ${JSON.stringify(m.params.toolCall).slice(0, 400)}`); select(agy, m, "reject_once"); }
  else agy.respond(m.id, { action: "decline" });
});
try {
  const { sessionId } = await openSession(agy, { cwd: root });
  const r = await agy.request("session/set_config_option", { sessionId, configId: "model", value: "gemini-3.8-flash" });
  console.log("set model", r.error ? JSON.stringify(r.error) : "ok");
  agy.note(`PROMPT sent at ${t0()}: ${userPrompt}`);
  console.log("PROMPT START", t0());
  const p = prompt(agy, sessionId, userPrompt);
  const res: any = await Promise.race([p, new Promise((x) => setTimeout(() => x({ result: { stopReason: "TIMEOUT 300s" } }), 300_000))]);
  console.log("prompt ->", res.result?.stopReason ?? JSON.stringify(res.error), "at", t0());
  await new Promise((x) => setTimeout(x, 3000));
  const seen: string[] = [];
  for (const m of agy.messages) {
    const u = m.params?.update;
    if (m.method === "session/update" && (u?.sessionUpdate === "tool_call" || u?.sessionUpdate === "tool_call_update"))
      seen.push(`${u.sessionUpdate} ${u.toolCallId?.slice(0, 14)} title=${u.title ?? ""} kind=${u.kind ?? ""} status=${u.status ?? ""} rawInput=${JSON.stringify(u.rawInput ?? null)?.slice(0, 300)} rawOutput=${JSON.stringify(u.rawOutput ?? null)?.slice(0, 600)}`);
  }
  console.log("ACP TOOL UPDATES:"); for (const l of seen) console.log(" ", l);
  console.log("REQUESTS:", requests.length); for (const q of requests) console.log(" ", q);
  const text = agy.messages.filter((m) => m.params?.update?.sessionUpdate === "agent_message_chunk").map((m) => m.params.update.content?.text ?? "").join("");
  console.log("TEXT:", text.slice(0, 800).replace(/\n/g, " "));
  console.log("AGY PID", agy.pid);
} finally { await agy.close(); process.exit(0); }
