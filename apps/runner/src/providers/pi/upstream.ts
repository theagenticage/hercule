/**
 * A model that always does the same thing, so the real pi binary can be driven
 * without a paid key and without a model's free will. It speaks the slice of
 * OpenAI's streaming chat-completions API pi's `openai-completions` client
 * sends: one SSE `data:` line per chunk, `data: [DONE]` at the end.
 *
 * The script is by request number, not by what was asked: the first completion
 * calls `bash` - and, where the test asks for a batch, a `write` beside it -
 * while every one after it answers in words and stops. That is the shape the
 * park needs: a tool call to stop, and a turn that can finish once the tool
 * has run.
 *
 * It listens on an ephemeral port on the loopback interface and is stopped by
 * the test that started it.
 */

/** What the first completion asks for, where a test needs more than the default. */
export interface Script {
  /** What the shell call runs, for a test that watches for its side effect. */
  readonly command?: string;
  /** A file written in the same batch as the shell call, asked for first. */
  readonly writes?: string;
}

export interface Upstream {
  /** What `models.json` points a provider's `baseUrl` at. */
  readonly baseUrl: string;
  /** How many completions pi has asked for, which is what the script counts. */
  readonly asked: () => number;
  readonly stop: () => void;
}

/** The command the scripted model always calls, and what it prints. */
export const PARKED_COMMAND = "echo parked";

export const PARKED_OUTPUT = "parked";

const chunk = (choice: Record<string, unknown>): string =>
  `data: ${JSON.stringify({
    id: "chatcmpl-hydra",
    object: "chat.completion.chunk",
    created: 1789373122,
    model: "scripted",
    choices: [{ index: 0, ...choice }],
  })}\n\n`;

const call = (
  index: number,
  name: string,
  args: Record<string, string>,
): Record<string, unknown> => ({
  index,
  id: `call_hydra_${name}`,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

const toolCall = (script: Script): string =>
  [
    chunk({ delta: { role: "assistant", content: "" }, finish_reason: null }),
    chunk({
      delta: {
        tool_calls: [
          ...(script.writes === undefined
            ? []
            : [call(0, "write", { path: script.writes, content: "written\n" })]),
          call(script.writes === undefined ? 0 : 1, "bash", {
            command: script.command ?? PARKED_COMMAND,
          }),
        ],
      },
      finish_reason: null,
    }),
    chunk({ delta: {}, finish_reason: "tool_calls" }),
    "data: [DONE]\n\n",
  ].join("");

const words = (): string =>
  [
    chunk({ delta: { role: "assistant", content: "" }, finish_reason: null }),
    chunk({ delta: { content: "Done." }, finish_reason: null }),
    chunk({ delta: {}, finish_reason: "stop" }),
    "data: [DONE]\n\n",
  ].join("");

export const scriptedUpstream = (script: Script = {}): Upstream => {
  let asked = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (!url.pathname.endsWith("/chat/completions")) {
        return new Response(JSON.stringify({ data: [{ id: "scripted" }] }), {
          headers: { "content-type": "application/json" },
        });
      }
      await request.text();
      asked += 1;
      return new Response(asked === 1 ? toolCall(script) : words(), {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    asked: () => asked,
    stop: () => void server.stop(true),
  };
};
