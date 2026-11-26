import { exp, startStandin, canary, mcpServer, readLog, turn, ASK_LIST, REC } from "../mcp-lib.ts";
const A = await startStandin("A", 28901, `${REC}/x9.A.jsonl`);
const tok = canary(); let n = 0;
const show = () => { const r = readLog(A.log).slice(n); n += r.length; console.log(`   A saw: ${r.filter((x) => x.rpc || x.answered).filter((x) => !String(x.rpc).startsWith("(GET")).map((x) => x.answered ? `ANSWERED-${x.answered}` : `${x.rpc}${x.tool ? "(" + x.tool + ")" : ""}`).join(" ")}`); };
const P = "List your MCP tools, one per line, then call the one named second and quote its result. If there is no tool second, reply NO SECOND.";
try {
  await exp({ name: "x9", mcpServers: [mcpServer("tools", A.url, tok)] }, async (c) => {
    await turn(c, ASK_LIST); show();
    await A.ctl({ tools: ["whoami", "second"] }); console.log("   -- added `second`, NO notification");
    await turn(c, P); show();
    await A.ctl({ fail404Roots: true }); console.log("   -- (b) next roots/list_changed gets 404");
    await turn(c, P); show();
    await turn(c, P); show();
  });
  // (c) resume in a new process, `second` added after the first process ended
  await A.ctl({ tools: ["whoami"] });
  let sid = "";
  await exp({ name: "x9c", mcpServers: [mcpServer("tools", A.url, tok)] }, async (c) => { sid = c.sessionId; await turn(c, ASK_LIST); show(); });
  await A.ctl({ tools: ["whoami", "second"] }); console.log("   -- (c) added `second` while no process runs; resume in new process");
  await exp({ name: "x9c", mcpServers: [mcpServer("tools", A.url, tok)] }, async (c) => { await turn(c, P); show(); }, { resumeId: sid, append: true });
} finally { await A.stop(); process.exit(0); }
