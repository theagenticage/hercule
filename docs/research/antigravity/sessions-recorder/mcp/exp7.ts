import { exp, startStandin, canary, mcpServer, turn, REC } from "../mcp-lib.ts";
import { setMode, FULL_ACCESS } from "../agy-session.ts";
const A = await startStandin("A", 28741, `${REC}/x7.A.jsonl`);
const tok = canary();
try {
  for (const v of ["default", "accept-edits", "skip"]) {
    await exp({ name: `x7-${v}`, flags: v === "skip" ? FULL_ACCESS : [], mcpServers: [mcpServer("tools", A.url, tok)] }, async (c) => {
      if (v === "accept-edits") console.log("   set_mode", JSON.stringify((await setMode(c.agy, c.sessionId, "accept-edits")).result ?? "err"));
      const { from } = await turn(c, "Call your MCP tool whoami now and quote its result in one line.");
      const asks = c.agy.messages.slice(from).filter((m) => m.method === "session/request_permission").length;
      console.log(`   RESULT ${v}: permission requests = ${asks}`);
    });
  }
} finally { await A.stop(); process.exit(0); }
