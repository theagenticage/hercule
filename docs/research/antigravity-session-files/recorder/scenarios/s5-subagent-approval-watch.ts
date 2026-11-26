import { prompt, summarize, select, sleep } from "../agy-session.ts";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { run1283, quotaHit, HOME, REC } from "../lib1283.ts";
const hooks = `${HOME}/config/hooks.json`;
if (existsSync(hooks)) { console.log("hooks.json already exists; abort"); process.exit(3); }
writeFileSync(hooks, JSON.stringify({ h: { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: "/tmp/hercule-1283/hook/hook.sh" }] }] } }));
try {
  await run1283("subagent-approval-watch", { mode: "default (approval required) + logging pre-tool hook in <home>/config/hooks.json", hookLog: `${REC}/subagent-approval-watch.hook.log (lines: epoch-ms + raw input; recording t = epoch-ms - started)` }, async (agy, ctx) => {
    agy.note(`recorder started at epoch ms ${agy.started}`);
    let requests = 0;
    agy.onRequest((m) => { if (m.method === "session/request_permission") { requests++; agy.note("permission request reached client; allowing"); select(agy, m, "allow_once"); } else agy.respond(m.id, { action: "decline" }); });
    let reply: any;
    const p = prompt(agy, ctx.sessionId, "Use a subagent for this: the subagent must run the shell command `echo hi > sub.txt` with its command tool, and then write a second file sub2.txt containing the text hi with its file tool. Say DONE when it is finished.").then((m) => { reply = m; agy.note(`PROMPT REPLIED ${JSON.stringify(m).slice(0, 400)}`); });
    const t0 = Date.now();
    let lastGrowth = 0;
    while (Date.now() - t0 < 330_000) {
      await sleep(1000);
      if (reply) { agy.note("prompt replied early"); break; }
      const rows = readFileSync(`${REC}/subagent-approval-watch.files.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const childIds = [...ctx.watcher.ids].filter((i) => i !== ctx.sessionId);
      for (const r of rows) if (r.path?.endsWith("/logs/transcript.jsonl") && childIds.some((c) => r.path.startsWith(c))) lastGrowth = Math.max(lastGrowth, r.t);
      if (lastGrowth && Date.now() - agy.started - lastGrowth >= 70_000) break;
    }
    agy.note(`70s after the child's last transcript line (lastGrowth t=${lastGrowth}); sending session/cancel`);
    agy.notify("session/cancel", { sessionId: ctx.sessionId });
    await Promise.race([p, sleep(15_000)]);
    agy.note("15s after cancel; closing");
    await sleep(15_000 - 0 > 0 ? 0 : 0);
    return `${reply ? summarize("p", reply) : "prompt never replied"}; permission requests reaching client=${requests} quota=${quotaHit(agy)}`;
  });
} finally { rmSync(hooks, { force: true }); }
