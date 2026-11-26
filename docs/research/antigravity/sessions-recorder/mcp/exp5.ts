import { exp, startStandin, canary, mcpServer, readLog, turn, ASK_CALL, REC } from "../mcp-lib.ts";
let A = await startStandin("A", 28711, `${REC}/x5.A.jsonl`);
const tok = canary(); let n = 0;
const show = () => { const r = readLog(A.log).slice(n); n += r.length; console.log(`   A saw: ${r.filter((x) => x.rpc || x.answered).map((x) => x.answered ? `ANSWERED-${x.answered}` : `${x.rpc}${x.tool ? "(" + x.tool + ")" : ""}${x.sid ? "" : "[nosid]"}`).join(" ")}`); };
try {
  await exp({ name: "x5", mcpServers: [mcpServer("tools", A.url, tok)] }, async (c) => {
    await turn(c, ASK_CALL); show();
    await A.ctl({ resetSessions: true });
    console.log("   -- 404 for the session id (sessions cleared)");
    await turn(c, "Call your MCP tool whoami again, quote the result or the exact error."); show();
    console.log("   -- real restart of the stand-in");
    await A.stop(); A = await startStandin("A", 28711, `${REC}/x5.A.jsonl`, false);
    await turn(c, "Call your MCP tool whoami again, quote the result or the exact error."); show();
    await turn(c, "Call your MCP tool whoami once more, quote the result or the exact error."); show();
  });
} finally { await A.stop(); process.exit(0); }
