import { exp, startStandin, canary, mcpServer, turn, REC } from "../mcp-lib.ts";
const A = await startStandin("A", 28731, `${REC}/x6.A.jsonl`);
const tok = canary();
try {
  await exp({ name: "x6", mcpServers: [mcpServer("tools", A.url, tok)] }, async (c) => {
    for (const mode of ["iserror", "rpcerror"]) {
      await A.ctl({ callMode: mode });
      const { from } = await turn(c, `Call your MCP tool whoami now, quote the result or the exact error. (${mode})`);
      for (const m of c.agy.messages.slice(from)) {
        const u = m.params?.update;
        if (m.method === "session/update" && u?.sessionUpdate === "tool_call_update" && ["completed", "failed"].includes(u.status)) console.log(`   FINAL ${mode}: ${JSON.stringify(u).slice(0, 700)}`);
      }
    }
  });
} finally { await A.stop(); process.exit(0); }
