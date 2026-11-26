import { writeFileSync, rmSync, existsSync, readFileSync, mkdirSync, copyFileSync } from "node:fs";
import { setup, cleanup, startNoted, openSession, prompt, freshWork, HOME } from "./trust-lib.ts";
import { FULL_ACCESS, setMode, select } from "../agy-session.ts";
// usage: bun t9-gate.ts <name> <mode: default|accept-edits|full> <run|edit|write> [ws]   (ws = also a workspace .agents/hooks.json hook)
const [name, mode, kind, ws] = process.argv.slice(2);
const OUT = "/tmp/hercule-1282/rec8";
const tmp = setup();
const dir = `/var/tmp/hercule-1282-hookdir/${name}`;
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
const log = `${dir}/out.log`;
writeFileSync(`${dir}/hook.sh`, `#!/bin/sh\n{ printf 'HOOK %s ts=%s mark=[%s]\\n' "$1" "$(date +%s%3N)" "$HERCULE_T9_MARK"; cat; echo; } >> ${log}\nexit 0\n`, { mode: 0o755 });
const hooks = `${HOME}/config/hooks.json`;
const backup = `${dir}/hooks.json.backup`;
const had = existsSync(hooks);
if (had) copyFileSync(hooks, backup);
const entry = (tag: string) => ({ PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: `sh ${dir}/hook.sh ${tag}` }] }] });
writeFileSync(hooks, JSON.stringify({ t9: entry("home") }));
const cwd = freshWork(`t9-${name}`, { "a.txt": "hello\n" });
if (ws) { mkdirSync(`${cwd}/.agents`, { recursive: true }); writeFileSync(`${cwd}/.agents/hooks.json`, JSON.stringify({ t9ws: entry("workspace") })); }
process.env.HERCULE_T9_MARK = `marks-${name}`;
const prompts: Record<string, string> = {
  run: "Run the shell command `echo hi` and tell me its output.",
  edit: "Edit the file a.txt in the working folder: replace 'hello' with 'goodbye'. Use your edit tool.",
  write: "Create a new file b.txt in the working folder with the text 'new'. Use your file-writing tool.",
};
const agy = startNoted({ cwd, out: `${OUT}/${name}.jsonl`, extraFlags: mode === "full" ? FULL_ACCESS : [] }, [`<home>/config/hooks.json: hook for every tool, tag home`, ws ? "workspace .agents/hooks.json tag workspace" : "no workspace hook", `env HERCULE_T9_MARK=marks-${name} set on agy process`]);
const perms: string[] = [];
try {
  agy.onRequest((m) => {
    if (m.method === "session/request_permission") {
      perms.push(`${Date.now()} request ${JSON.stringify(m.params.toolCall).slice(0, 200)}`);
      agy.note(`permission request at ${Date.now()}: toolCallId=${m.params.toolCall?.toolCallId}`);
      setTimeout(() => { agy.note(`allow answered at ${Date.now()}`); perms.push(`${Date.now()} allow`); select(agy, m, "allow_once"); }, 1500);
    } else agy.respond(m.id, { action: "decline" });
  });
  const { sessionId } = await openSession(agy, { cwd });
  if (mode === "accept-edits") await setMode(agy, sessionId, "accept-edits");
  const r = await prompt(agy, sessionId, prompts[kind]);
  console.log(name, r.result?.stopReason ?? JSON.stringify(r.error));
  for (const m of agy.messages) {
    const u = m.params?.update;
    if (m.method === "session/update" && (u?.sessionUpdate === "tool_call")) console.log("tool_call", u.toolCallId, u.title, u.kind, u.status, JSON.stringify(u.rawInput ?? {}).slice(0, 120));
  }
  console.log("perms:", perms);
  console.log("HOOK LOG:\n" + (existsSync(log) ? readFileSync(log, "utf8") : "(hook not run)"));
} finally {
  await agy.close();
  if (had) copyFileSync(backup, hooks); else rmSync(hooks, { force: true });
  cleanup(tmp);
}
