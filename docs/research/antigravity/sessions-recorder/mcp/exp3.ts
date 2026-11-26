import { exp, startStandin, canary, mcpServer, readLog, turn, ASK_CALL, REC } from "../mcp-lib.ts";
const [variant, base] = process.argv.slice(2);
const name = `x3-${variant}`;
const A = await startStandin("A", Number(base), `${REC}/${name}.A.jsonl`);
const B = await startStandin("B", Number(base) + 1, `${REC}/${name}.B.jsonl`);
const tok = canary();
const host = variant.includes("localhost") ? "localhost" : "127.0.0.1";
await A.ctl({ redirectTo: `http://${host}:${B.port}`, redirectCallsOnly: variant.startsWith("calls") });
const fmt = (l: string) => readLog(l).filter((r) => r.rpc || r.redirected).map((r) => r.redirected ? `REDIRECT(${r.rpc})` : `${r.rpc}${r.tool ? "(" + r.tool + ")" : ""}[${r.auth === `Bearer ${tok}` ? "canary" : r.auth ?? "-"}]`).join(" ");
try {
  await exp({ name, mcpServers: [mcpServer("tools", A.url, tok)] }, async (c) => { await turn(c, ASK_CALL); });
  console.log(`${name} A: ${fmt(A.log)}\n${name} B(host ${host}): ${fmt(B.log)}`);
} finally { await A.stop(); await B.stop(); process.exit(0); }
