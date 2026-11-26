import { prompt, summarize, select, sleep } from "../agy-session.ts";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { startStandin, mcpServer, requestsOf } from "../mcp-lib.ts";
import { setMode } from "../agy-session.ts";
import { run1283, quotaHit, HOME, REC } from "../lib1283.ts";
const name = "subagent-mcp-accept-edits";
const standin = await startStandin("tools", 18931, `${REC}/${name}.mcp.jsonl`);
const hooks = `${HOME}/config/hooks.json`;
if (existsSync(hooks)) { console.log("hooks.json already exists; abort"); process.exit(3); }
writeFileSync(hooks, JSON.stringify({ h: { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: "/tmp/hercule-1283/hook/hook-mcp.sh" }] }] } }));
try {
  await run1283(name, { mcpServers: [mcpServer("tools", standin.url, null)], mode: "accept-edits (Auto-accept edits) via session/set_mode + logging pre-tool hook", hookLog: `${REC}/${name}.hook.log (epoch-ms + raw input; t = epoch-ms - started)` }, async (agy, ctx) => {
    agy.note(`recorder started at epoch ms ${agy.started}; MCP stand-in ${standin.url} server name tools`);
    agy.note(`set_mode ${JSON.stringify((await setMode(agy, ctx.sessionId, "accept-edits")).result ?? "err")}`);
    let requests = 0;
    agy.onRequest((m) => { if (m.method === "session/request_permission") { requests++; agy.note(`permission request reached client; allowing: ${JSON.stringify(m.params?.toolCall?.title)}`); select(agy, m, "allow_once"); } else agy.respond(m.id, { action: "decline" }); });
    let reply: any;
    const p = prompt(agy, ctx.sessionId, "Use invoke_subagent to start one subagent with the Role 'Caller'. Its task: call the MCP tool whoami once and report what it returned. When it has reported, reply with that.").then((m) => { reply = m; agy.note(`PROMPT REPLIED ${JSON.stringify(m).slice(0, 400)}`); });
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
} finally { rmSync(hooks, { force: true }); console.log(requestsOf(standin.log).join("\n")); await standin.stop(); }
