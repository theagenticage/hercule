import { exp, startStandin, canary, mcpServer, readLog, turn, ASK_CALL, REC } from "../mcp-lib.ts";
const A = await startStandin("A", 28701, `${REC}/x4.A.jsonl`);
const tok = canary(); let n = 0;
const show = (l: string) => { const r = readLog(A.log).slice(n); n += r.length; console.log(`   A saw: ${r.filter((x) => x.rpc || x.answered).map((x) => x.answered ? `ANSWERED-${x.answered}` : `${x.rpc}${x.tool ? "(" + x.tool + ")" : ""}`).join(" ")}`); };
try {
  await exp({ name: "x4", mcpServers: [mcpServer("tools", A.url, tok)] }, async (c) => {
    await turn(c, ASK_CALL); show("t1");
    console.log("   ctl", JSON.stringify(await A.ctl({ tools: ["whoami", "second"], notifyInResponse: true, notify: true })));
    await turn(c, "Call your MCP tool whoami again, quote the result."); show("t2");
    await turn(c, "Call your MCP tool named second now, quote the result. If you have no such tool, reply NO TOOL."); show("t3");
    console.log("   ctl: remove whoami", JSON.stringify(await A.ctl({ tools: ["second"], notifyInResponse: true, notify: true })));
    await turn(c, "Call your MCP tool whoami now, quote the result or the exact error."); show("t4");
    await turn(c, "Call your MCP tool whoami once more, quote the result or the exact error."); show("t5");
  });
} finally { await A.stop(); process.exit(0); }
