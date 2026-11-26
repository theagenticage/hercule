import { writeFileSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { setup, cleanup, handle, startNoted, openSession, prompt, freshWork, toolNames, HOME } from "./trust-lib.ts";
import { FULL_ACCESS } from "../agy-session.ts";
// usage: bun t8-websearch.ts <variant: deny|ask|force_ask|capture|allow_capture> <mode: default|full> [matcher]
const [variant, mode, matcherArg] = process.argv.slice(2);
const OUT = "/tmp/hercule-1282/rec6";
const tmp = setup();
const dir = `/var/tmp/hercule-1282-hookdir/${variant}-${mode}`;
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
const input = `${dir}/input.jsonl`;
const decision = variant === "capture" ? "allow" : variant === "allow_capture" ? "allow" : variant;
writeFileSync(`${dir}/hook.sh`, `#!/bin/sh\n{ cat; echo; } >> ${input}\necho '{"decision":"${decision}","reason":"hook test ${variant}"}'\n`, { mode: 0o755 });
const hooks = `${HOME}/config/hooks.json`;
if (existsSync(hooks)) { console.log("hooks.json exists, abort"); process.exit(3); }
const matcher = matcherArg ?? "search_web";
writeFileSync(hooks, JSON.stringify({ t8: { PreToolUse: [{ matcher, hooks: [{ type: "command", command: `sh ${dir}/hook.sh` }] }] } }));
const cwd = freshWork(`t8-${variant}-${mode}`);
const extraFlags = mode === "full" ? FULL_ACCESS : [];
const agy = startNoted({ cwd, out: `${OUT}/t8-${variant}-${mode}.jsonl`, extraFlags }, [`<home>/config/hooks.json = PreToolUse matcher ${JSON.stringify(matcher)} -> sh ${dir}/hook.sh (decision ${decision})`]);
try {
  const perms = handle(agy);
  const { sessionId } = await openSession(agy, { cwd });
  const r = await prompt(agy, sessionId, process.env.PROMPT ?? "Use your web search tool to search for: hercule hook test");
  const text = agy.messages.filter((m) => m.params?.update?.sessionUpdate === "agent_message_chunk").map((m) => m.params.update.content?.text ?? "").join("");
  const tools = agy.messages.filter((m) => m.params?.update?.sessionUpdate === "tool_call_update" || m.params?.update?.sessionUpdate === "tool_call").map((m) => `${m.params.update.sessionUpdate}:${m.params.update.title ?? ""}:${m.params.update.status ?? ""}`);
  console.log(variant, mode, r.result?.stopReason ?? JSON.stringify(r.error), "perms:", perms, "tools:", toolNames(agy));
  console.log("tool updates:", [...new Set(tools)]);
  console.log("TEXT:", text.slice(0, 600));
  console.log("HOOK INPUT:", existsSync(input) ? readFileSync(input, "utf8").slice(0, 3000) : "(hook not run)");
} finally { await agy.close(); rmSync(hooks, { force: true }); cleanup(tmp); }
