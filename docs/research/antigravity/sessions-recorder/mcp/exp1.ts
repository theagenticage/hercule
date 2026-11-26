import { exp, startStandin, canary, mcpServer, fileEntry, requestsOf, turn, ASK_CALL, REC } from "../mcp-lib.ts";
// usage: bun exp1.ts <place> <acp|noacp> <portBase>
const [place, mode, base] = process.argv.slice(2);
const name = `x1-${place}-${mode}`;
const A = await startStandin("A", Number(base), `${REC}/${name}.A.jsonl`);
const B = await startStandin("B", Number(base) + 1, `${REC}/${name}.B.jsonl`);
const ta = canary(), tb = canary();
const entry = fileEntry("tools", B.url, tb);
const gem = JSON.stringify({ mcpServers: { tools: { url: B.url, headers: { Authorization: `Bearer ${tb}` } } } }, null, 2);
const places: Record<string, any> = {
  home: { homeMcp: entry },
  ws: { files: { "ws/.agents/mcp_config.json": entry }, cwdRel: "ws" },
  wsgem: { files: { "ws/.gemini/settings.json": gem }, cwdRel: "ws" },
  wsroot: { files: { "ws/mcp_config.json": entry, "ws/.mcp.json": entry }, cwdRel: "ws" },
  gitroot: { files: { "repo/.agents/mcp_config.json": entry, "repo/.gemini/settings.json": gem }, git: ["repo"], cwdRel: "repo/sub" },
  parent: { files: { "parent/.agents/mcp_config.json": entry, "parent/.gemini/settings.json": gem }, cwdRel: "parent/child" },
  fakehome: { files: { "fakehome/.gemini/config/mcp_config.json": entry, "fakehome/.gemini/settings.json": gem, "fakehome/.agents/mcp_config.json": entry }, fakeHome: true, cwdRel: "ws" },
};
try {
  await exp({ name, ...places[place], mcpServers: mode === "acp" ? [mcpServer("tools", A.url, ta)] : [], noteExtra: { standins: { A: A.url, B: B.url }, place, mode } }, async (c) => {
    await turn(c, ASK_CALL);
  });
  console.log(`${name} A:\n  ${requestsOf(A.log).join("\n  ")}\n${name} B:\n  ${requestsOf(B.log).join("\n  ")}`);
} finally { await A.stop(); await B.stop(); process.exit(0); }
