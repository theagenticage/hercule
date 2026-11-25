// Spike: runs one real `agy acp` turn against the repo's fake MCP server and prints
// what agy sends: the MCP requests (with or without the bearer), the permission
// requests, the session updates and the turn's result.
// Usage: bun mcp-turn.ts <repo root> <agy wrapper> <gemini dir> <cwd> <mode> <tool>
const [repo, wrapper, geminiDir, cwd, mode, tool] = process.argv.slice(2) as [
  string, string, string, string, string, string,
];
const { startFakeMcpServer } = await import(
  `${repo}/apps/runner/src/harnesses/fake-mcp-server.testing.ts`
);
const fake = startFakeMcpServer();
const child = Bun.spawn(
  [wrapper, "acp", "--process-per-session", "--gemini-dir", geminiDir, "--app-data-dir", "antigravity-acp"],
  { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
);
let nextId = 1;
const waiting = new Map<number, (message: any) => void>();
const send = (message: unknown) => {
  child.stdin.write(`${JSON.stringify(message)}\n`);
  child.stdin.flush();
};
const request = (method: string, params: unknown): Promise<any> =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
const short = (value: unknown, length = 260) => JSON.stringify(value)?.slice(0, length);
let text = "";
const started = Date.now();
const at = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

const handle = (message: any) => {
  if (message.id !== undefined && message.method === undefined) {
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
    return;
  }
  if (message.method === "session/request_permission") {
    const { toolCall, options } = message.params;
    console.log(`${at()} PERMISSION title=${short(toolCall?.title)} kind=${toolCall?.kind} status=${toolCall?.status}`);
    console.log(`     options=${short(options.map((o: any) => `${o.kind}:${o.optionId}:${o.name}`), 400)}`);
    const allow = options.find((o: any) => o.kind === "allow_once") ?? options[0];
    send({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "selected", optionId: allow.optionId } } });
    return;
  }
  if (message.method === "session/update") {
    const update = message.params.update;
    if (update.sessionUpdate === "agent_message_chunk") text += update.content?.text ?? "";
    else if (update.sessionUpdate === "agent_thought_chunk") return;
    else if (update.sessionUpdate === "available_commands_update") return;
    else console.log(`${at()} UPDATE ${update.sessionUpdate} ${short({ ...update, sessionUpdate: undefined }, 420)}`);
    return;
  }
  console.log(`${at()} INCOMING ${message.method} id=${message.id} ${short(message.params)}`);
  if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not supported" } });
};

void (async () => {
  let buffer = "";
  for await (const chunk of child.stdout) {
    buffer += new TextDecoder().decode(chunk);
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim() !== "") handle(JSON.parse(line));
    }
  }
})();
void (async () => {
  for await (const chunk of child.stderr) console.log(`STDERR ${new TextDecoder().decode(chunk).slice(0, 300)}`);
})();

const deadline = setTimeout(() => {
  console.log("TIMEOUT after 150s");
  finish();
}, 150_000);
const finish = () => {
  clearTimeout(deadline);
  console.log(`agent text: ${short(text, 500)}`);
  console.log("MCP requests the fake received:");
  for (const r of fake.requests) console.log(`   ${r.method}${r.tool ? ` ${r.tool}` : ""} authorization=${r.authorization}`);
  console.log(`tools called: ${short(fake.listCalledTools())}`);
  child.kill();
  fake.stop();
  process.exit(0);
};

const init = await request("initialize", {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: "acp-spike", version: "0.0.1" },
});
console.log(`initialize mcpCapabilities=${short(init.result?.agentCapabilities?.mcpCapabilities)}`);
const auth = await request("authenticate", { methodId: "oauth-personal" });
console.log(`authenticate ${auth.error ? `ERROR ${short(auth.error)}` : "ok"}`);
const session = await request("session/new", {
  cwd,
  mcpServers: [
    { type: "http", name: "tools", url: fake.url, headers: [{ name: "Authorization", value: "Bearer spike-token" }] },
  ],
});
if (session.error) {
  console.log(`session/new ERROR ${short(session.error)}`);
  finish();
}
const sessionId = session.result.sessionId;
console.log(`${at()} session ${sessionId}`);
if (mode !== "default") {
  const set = await request("session/set_mode", { sessionId, modeId: mode });
  console.log(`set_mode ${mode}: ${short(set.error ?? set.result)}`);
}
const turn = await request("session/prompt", {
  sessionId,
  prompt: [
    {
      type: "text",
      text: `Call the MCP tool ${tool} once and tell me in one sentence what it returned. Do nothing else: no file reads, no shell commands.`,
    },
  ],
});
console.log(`${at()} prompt result: ${short(turn.error ?? turn.result, 500)}`);
finish();
