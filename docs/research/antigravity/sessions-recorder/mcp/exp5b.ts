import { exp, startStandin, canary, mcpServer, readLog, turn, ASK_CALL, REC } from "../mcp-lib.ts";
const A = await startStandin("A", 28721, `${REC}/x5b.A.jsonl`);
const tok = canary(); let n = 0;
const show = () => { const r = readLog(A.log).slice(n); n += r.length; console.log(`   A saw: ${r.filter((x) => x.rpc || x.answered).map((x) => x.answered ? `ANSWERED-${x.answered}` : `${x.rpc}${x.tool ? "(" + x.tool + ")" : ""}${x.sid ? "" : "[nosid]"}`).join(" ")}`); };
try {
  await exp({ name: "x5b", mcpServers: [mcpServer("tools", A.url, tok)] }, async (c) => {
    await turn(c, ASK_CALL); show();
    await A.ctl({ fail404Call: true });
    console.log("   -- 404 on the tools/call itself (sessions cleared)");
    await turn(c, "Call your MCP tool whoami again, quote the result or the exact error."); show();
  });
} finally { await A.stop(); process.exit(0); }
