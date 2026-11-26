import { prompt, summarize, select, sleep } from "../agy-session.ts";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { run1283, quotaHit, HOME, REC } from "../lib1283.ts";
const name = "subagent-read-outside";
const hooks = `${HOME}/config/hooks.json`;
if (existsSync(hooks)) { console.log("hooks.json already exists; abort"); process.exit(3); }
writeFileSync(hooks, JSON.stringify({ h: { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: "/tmp/hercule-1283/hook/hook-ro.sh" }] }] } }));
try {
  await run1283(name, { mode: "default (approval required) + logging pre-tool hook", hookLog: `${REC}/${name}.hook.log (epoch-ms + raw input; t = epoch-ms - started)` }, async (agy, ctx) => {
    agy.note(`recorder started at epoch ms ${agy.started}; outside file /var/tmp/hercule-1283-outside/note.txt contains OUTSIDEMARK`);
    let requests = 0;
    agy.onRequest((m) => { if (m.method === "session/request_permission") { requests++; agy.note(`permission request reached client; allowing: ${JSON.stringify(m.params?.toolCall?.title)}`); select(agy, m, "allow_once"); } else agy.respond(m.id, { action: "decline" }); });
    let reply: any;
    const p = prompt(agy, ctx.sessionId, "Use invoke_subagent to start one subagent with the Role 'Reader'. Its task: read the file /var/tmp/hercule-1283-outside/note.txt with its read_file tool and report the file's content back to you. When it has reported, reply with that content.").then((m) => { reply = m; agy.note(`PROMPT REPLIED ${JSON.stringify(m).slice(0, 400)}`); });
    const t0 = Date.now(); let lastGrowth = 0;
    while (Date.now() - t0 < 300_000) {
      await sleep(1000);
      if (reply) break;
      const rows = readFileSync(`${REC}/${name}.files.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const childIds = [...ctx.watcher.ids].filter((i) => i !== ctx.sessionId);
      for (const r of rows) if (r.path?.endsWith("/logs/transcript.jsonl") && childIds.some((c) => r.path.startsWith(c))) lastGrowth = Math.max(lastGrowth, r.t);
      if (lastGrowth && Date.now() - agy.started - lastGrowth >= 90_000) break;
    }
    if (!reply) { agy.note(`no reply; child last transcript t=${lastGrowth}; sending session/cancel`); agy.notify("session/cancel", { sessionId: ctx.sessionId }); await Promise.race([p, sleep(10_000)]); agy.note("10s after cancel; closing"); }
    else await sleep(5000);
    return `${reply ? summarize("p", reply) : "prompt never replied"}; permission requests=${requests} quota=${quotaHit(agy)}`;
  });
} finally { rmSync(hooks, { force: true }); }
