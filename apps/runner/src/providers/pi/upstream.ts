/**
 * A fake model server with fixed replies, so tests can drive the real pi
 * binary without a paid key and without depending on what a real model says.
 * It implements the part of OpenAI's streaming chat-completions API that pi's
 * `openai-completions` client uses: one SSE `data:` line per chunk, and
 * `data: [DONE]` at the end.
 *
 * The reply depends only on the request number, not on the request content:
 *
 * - the first completion calls `bash`, plus a `write` before it when the test
 *   asks for a batch;
 * - every later completion replies with text and stops.
 *
 * That is what a park test needs: a tool call for pi to hold, and a turn that
 * can finish once the tool has run.
 *
 * The server listens on a random free port on the loopback interface. The test
 * that starts it also stops it.
 */

/** Options for the first completion's tool calls, for tests that need more than the default. */
export interface FakeModelFirstTurn {
  /** The command the `bash` call runs, for a test that checks its side effect. */
  readonly command?: string;
  /** A file path for a `write` call in the same batch, placed before the `bash` call. */
  readonly writes?: string;
}

export interface FakeModelServer {
  /** The URL to put in a provider's `baseUrl` in `models.json`. */
  readonly baseUrl: string;
  /** Returns how many completions pi has requested so far. */
  readonly asked: () => number;
  readonly stop: () => void;
}

/** The default command the fake model runs, and the text it prints. */
export const PARKED_COMMAND = "echo parked";

export const PARKED_OUTPUT = "parked";

const formatChunk = (choice: Record<string, unknown>): string =>
  `data: ${JSON.stringify({
    id: "chatcmpl-hercule",
    object: "chat.completion.chunk",
    created: 1789373122,
    model: "fake-model",
    choices: [{ index: 0, ...choice }],
  })}\n\n`;

const buildToolCallDelta = (
  index: number,
  name: string,
  args: Record<string, string>,
): Record<string, unknown> => ({
  index,
  id: `call_hercule_${name}`,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

const buildToolCallReply = (firstTurn: FakeModelFirstTurn): string =>
  [
    formatChunk({ delta: { role: "assistant", content: "" }, finish_reason: null }),
    formatChunk({
      delta: {
        tool_calls: [
          ...(firstTurn.writes === undefined
            ? []
            : [buildToolCallDelta(0, "write", { path: firstTurn.writes, content: "written\n" })]),
          buildToolCallDelta(firstTurn.writes === undefined ? 0 : 1, "bash", {
            command: firstTurn.command ?? PARKED_COMMAND,
          }),
        ],
      },
      finish_reason: null,
    }),
    formatChunk({ delta: {}, finish_reason: "tool_calls" }),
    "data: [DONE]\n\n",
  ].join("");

const buildTextReply = (): string =>
  [
    formatChunk({ delta: { role: "assistant", content: "" }, finish_reason: null }),
    formatChunk({ delta: { content: "Done." }, finish_reason: null }),
    formatChunk({ delta: {}, finish_reason: "stop" }),
    "data: [DONE]\n\n",
  ].join("");

export const startFakeModelServer = (firstTurn: FakeModelFirstTurn = {}): FakeModelServer => {
  let asked = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (!url.pathname.endsWith("/chat/completions")) {
        return new Response(JSON.stringify({ data: [{ id: "fake-model" }] }), {
          headers: { "content-type": "application/json" },
        });
      }
      await request.text();
      asked += 1;
      return new Response(asked === 1 ? buildToolCallReply(firstTurn) : buildTextReply(), {
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
