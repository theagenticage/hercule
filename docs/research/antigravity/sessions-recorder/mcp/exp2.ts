import { exp, startStandin, canary, mcpServer, readLog, turn, ASK_CALL, REC } from "../mcp-lib.ts";
const A = await startStandin("A", 28401, `${REC}/x2.A.jsonl`);
const c1 = canary(), c2 = canary();
const show = (label: string, from: number) => { const l = readLog(A.log).slice(from); console.log(`${label}: ${l.filter((r) => r.rpc).map((r) => `${r.rpc}${r.tool ? "(" + r.tool + ")" : ""}[${r.auth === c1 ? "c1" : r.auth === `Bearer ${c1}` ? "c1" : r.auth === `Bearer ${c2}` ? "c2" : r.auth ?? "-"}]`).join(" ")}`); return readLog(A.log).length; };
let sid = "", n = 0;
try {
  await exp({ name: "x2", mcpServers: [mcpServer("tools", A.url, c1)] }, async (c) => { sid = c.sessionId; await turn(c, ASK_CALL); });
  n = show("run1 new (c1)", 0);
  await exp({ name: "x2", mcpServers: [] }, async (c) => { await turn(c, ASK_CALL); }, { resumeId: sid, append: true });
  n = show("run2 resume mcpServers=[]", n);
  await exp({ name: "x2", mcpServers: [mcpServer("tools", A.url, c2)] }, async (c) => { await turn(c, ASK_CALL); }, { resumeId: sid, append: true });
  n = show("run3 resume with c2", n);
  // run4: resume with [] but the first process's canary c1 only
} finally { await A.stop(); process.exit(0); }
