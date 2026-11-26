import { exp, startStandin, canary, mcpServer, requestsOf, turn, ASK_LIST, ASK_CALL, REC } from "../mcp-lib.ts";
const A = await startStandin("A", 28701, `${REC}/base.A.jsonl`);
const tok = canary();
try {
  await exp({ name: "base", mcpServers: [mcpServer("tools", A.url, tok)] }, async (c) => {
    await turn(c, ASK_LIST);
    await turn(c, ASK_CALL);
  });
  console.log("A requests:\n  " + requestsOf(A.log).join("\n  "));
} finally { await A.stop(); }
