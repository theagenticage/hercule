import { writeFileSync, rmSync, existsSync, readFileSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { startAgy, openSession, prompt, select, setMode } from "./t12-session.ts";
// usage: bun t12-run.ts <name> <mode default|accept-edits> <hook command line, or "-" for none> [timeoutField]
const [name, mode, hookCmd, timeoutField] = process.argv.slice(2);
const S = "/var/tmp/hercule-1282-t12", HOME = `${S}/home`, OUT = "/tmp/hercule-1282/rec12";
const root = `${S}/work/${name}`;
rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true });
execSync("git init -q", { cwd: root });
const hookLog = `${OUT}/${name}.hook.log`; rmSync(hookLog, { force: true });
process.env.HERCULE_T12_LOG = hookLog;
const hooks = `${HOME}/config/hooks.json`;
rmSync(`${HOME}/config`, { recursive: true, force: true }); mkdirSync(`${HOME}/config`, { recursive: true });
if (hookCmd !== "-") {
  const h: any = { type: "command", command: hookCmd };
  if (timeoutField) h.timeout = Number(timeoutField);
  writeFileSync(hooks, JSON.stringify({ h: { PreToolUse: [{ matcher: "write_file|run_command", hooks: [h] }] } }));
}
const out = `${OUT}/${name}.jsonl`;
const agy = startAgy({ home: HOME, cwd: root, out, extraFlags: [] });
const requests: string[] = [];
try {
  agy.onRequest((m) => {
    if (m.method === "session/request_permission") {
      requests.push(`${Date.now()} ${JSON.stringify(m.params.toolCall).slice(0, 200)}`);
      select(agy, m, "allow_once");
    } else agy.respond(m.id, { action: "decline" });
  });
  const { sessionId } = await openSession(agy, { cwd: root });
  await agy.request("session/set_config_option", { sessionId, configId: "model", value: "gemini-3.8-flash" });
  if (mode !== "default") await setMode(agy, sessionId, mode);
  const prompts = [
    "Use your write_file tool to create the file hello.txt in the working folder with the content: hi. Then reply with the exact, complete text of the tool result or error message you received, copied verbatim, and nothing else; if the tool did not run, say what you saw.",
    "Use your run_command tool to run exactly: echo hi. Then reply with the exact, complete text of the tool result or error message you received, copied verbatim, and nothing else; if the tool did not run, say what you saw.",
  ];
  for (const pr of prompts) {
    agy.note(`PROMPT: ${pr}`);
    const from = agy.messages.length, t0 = Date.now(), r0 = requests.length;
    const p = prompt(agy, sessionId, pr);
    const r: any = await Promise.race([p, new Promise((res) => setTimeout(() => res({ result: { stopReason: "TIMEOUT 200s" } }), 200_000))]);
    console.log(`== PROMPT ${JSON.stringify(pr.slice(0, 40))} -> ${r.result?.stopReason ?? JSON.stringify(r.error)} in ${Date.now() - t0} ms; requests this prompt: ${requests.length - r0}`);
    for (const m of agy.messages.slice(from)) {
      const u = m.params?.update;
      if (m.method === "session/update" && (u?.sessionUpdate === "tool_call" || u?.sessionUpdate === "tool_call_update"))
        console.log("  TOOL", u.sessionUpdate, u.status ?? "", JSON.stringify({ title: u.title, content: u.content, rawOutput: u.rawOutput }).slice(0, 500));
    }
    const text = agy.messages.slice(from).filter((m) => m.params?.update?.sessionUpdate === "agent_message_chunk").map((m) => m.params.update.content?.text ?? "").join("");
    console.log("  AGENT TEXT:", text.slice(0, 400).replace(/\n/g, " "));
  }
  console.log("REQUESTS:", requests.length); for (const q of requests) console.log(" ", q);
  console.log("HOOK LOG:\n" + (existsSync(hookLog) ? readFileSync(hookLog, "utf8") : "(no hook ran)"));
  const list = (d: string, p = ""): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.name === ".git" ? [] : e.isDirectory() ? list(join(d, e.name), `${p}${e.name}/`) : [`${p}${e.name}`]);
  console.log("FILES:", list(root).join(" "));
} finally { await agy.close(); process.exit(0); }
