// Spike: runs one real `agy acp` session and records every JSON-RPC message in both
// directions to a JSONL file, so the event mapping can be built from what agy really sends.
// Usage: bun record-turn.ts <agy wrapper> <gemini dir> <cwd> <out.jsonl> <scenario json>
// Scenario: { mode?, prompt, permission?: "allow"|"deny"|"cancel", cancelAfterMs?, steerAfterMs?, steerText?,
//             secondPrompt?, model?, waitAfterMs? }
import { appendFileSync, writeFileSync } from "node:fs";

const [wrapper, geminiDir, cwd, out, scenarioJson] = process.argv.slice(2) as [string, string, string, string, string];
const scenario = JSON.parse(scenarioJson) as {
  mode?: string; prompt: string; permission?: "allow" | "deny" | "cancel"; cancelAfterMs?: number;
  steerAfterMs?: number; steerText?: string; secondPrompt?: string; model?: string; waitAfterMs?: number;
  clientCapabilities?: Record<string, unknown>;
};
writeFileSync(out, "");
const started = Date.now();
const record = (direction: "in" | "out", message: unknown) =>
  appendFileSync(out, `${JSON.stringify({ t: Date.now() - started, direction, message })}\n`);

const child = Bun.spawn(
  [wrapper, "acp", "--process-per-session", "--gemini-dir", geminiDir, "--app-data-dir", "antigravity-acp"],
  { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
);
let nextId = 1;
const waiting = new Map<number, (message: any) => void>();
const send = (message: unknown) => {
  record("out", message);
  child.stdin.write(`${JSON.stringify(message)}\n`);
  child.stdin.flush();
};
const request = (method: string, params: unknown): Promise<any> =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });

const handle = (message: any) => {
  record("in", message);
  if (message.id !== undefined && message.method === undefined) {
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
    return;
  }
  if (message.method === "session/request_permission") {
    const options = message.params.options as Array<{ kind: string; optionId: string }>;
    const policy = scenario.permission ?? "allow";
    if (policy === "cancel") {
      send({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "cancelled" } } });
      return;
    }
    const wanted = policy === "allow" ? "allow_once" : "reject_once";
    const option = options.find((o) => o.kind === wanted) ?? options[0]!;
    send({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "selected", optionId: option.optionId } } });
    return;
  }
  if (message.method === "elicitation/create") {
    // Answers a form with the first allowed value of each property, so the recording shows what agy does next.
    const properties = (message.params?.requestedSchema?.properties ?? {}) as Record<string, any>;
    const content: Record<string, unknown> = {};
    for (const [name, property] of Object.entries(properties)) {
      const choice = property.enum?.[0] ?? property.oneOf?.[0]?.const ?? property.items?.enum?.[0] ?? "Green";
      content[name] = property.type === "array" ? [choice] : choice;
    }
    send({ jsonrpc: "2.0", id: message.id, result: { action: "accept", content } });
    return;
  }
  if (message.id !== undefined && message.method !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  }
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
  for await (const chunk of child.stderr) record("in", { stderr: new TextDecoder().decode(chunk) });
})();

const finish = (why: string) => {
  record("out", { finished: why });
  child.kill();
  process.exit(0);
};
setTimeout(() => finish("timeout 230s"), 230_000);

await request("initialize", {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, ...scenario.clientCapabilities },
  clientInfo: { name: "acp-spike", version: "0.0.1" },
});
await request("authenticate", { methodId: "oauth-personal" });
const session = await request("session/new", { cwd, mcpServers: [] });
if (session.error) finish("session/new failed");
const sessionId = session.result.sessionId as string;
if (scenario.model) await request("session/set_config_option", { sessionId, configId: "model", value: scenario.model });
if (scenario.mode) await request("session/set_mode", { sessionId, modeId: scenario.mode });

const text = (value: string) => [{ type: "text", text: value }];
if (scenario.cancelAfterMs) setTimeout(() => send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } }), scenario.cancelAfterMs);
if (scenario.steerAfterMs) {
  setTimeout(() => void request("session/prompt", { sessionId, prompt: text(scenario.steerText ?? "Also say the word banana.") }), scenario.steerAfterMs);
}
await request("session/prompt", { sessionId, prompt: text(scenario.prompt) });
if (scenario.secondPrompt) await request("session/prompt", { sessionId, prompt: text(scenario.secondPrompt) });
await new Promise((resolve) => setTimeout(resolve, scenario.waitAfterMs ?? 1500));
finish("done");
