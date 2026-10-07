/**
 * A fake model server with scripted replies, so tests can drive the real pi
 * binary without a paid key and without depending on what a real model says.
 * It implements the part of OpenAI's streaming chat-completions API that pi's
 * `openai-completions` client uses: one SSE `data:` line per chunk, and
 * `data: [DONE]` at the end.
 *
 * A script chooses each reply. `startFakeModelServer` uses the default script,
 * which looks only at the request number:
 *
 * - the first completion calls `bash`, plus a `write` before it when the test
 *   asks for a batch;
 * - every later completion replies with text and stops.
 *
 * That is what a park test needs: a tool call for pi to hold, and a turn that
 * can finish once the tool has run.
 *
 * `startScriptedModelServer` takes a script of the test's own. A test with
 * several pi processes on one server, such as a session and its subagents,
 * chooses the reply from the conversation in the request, because the
 * processes ask in no fixed order.
 *
 * The server listens on a random free port on the loopback interface. The test
 * that starts it also stops it.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** Options for the first completion's tool calls, for tests that need more than the default. */
export interface FakeModelFirstTurn {
  /** The command the `bash` call runs, for a test that checks its side effect. */
  readonly command?: string;
  /** A file path for a `write` call in the same batch, placed before the `bash` call. */
  readonly writes?: string;
}

/** One tool call in a scripted reply: the tool's name and its arguments. */
export interface FakeToolCall {
  readonly name: string;
  readonly args: Readonly<Record<string, string>>;
}

/** Token counts a scripted reply reports, as the chunk's `usage` field carries them. */
export interface FakeModelUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

/**
 * One completion the fake model streams back: either tool calls, which pi
 * runs in parallel when there are several, or text that ends the turn.
 * `usage` is reported in the last chunk when it is given.
 */
export type FakeModelReply =
  | { readonly toolCalls: ReadonlyArray<FakeToolCall>; readonly usage?: FakeModelUsage }
  | { readonly text: string; readonly usage?: FakeModelUsage };

/** One message of a completion request, in OpenAI's chat-completions format. */
export interface FakeModelMessage {
  readonly role: string;
  /** A string, or a list of parts of which the `text` parts hold the text. */
  readonly content?: unknown;
}

/** A completion request as pi sends it, with only the fields a script reads. */
export interface FakeModelRequest {
  readonly messages: ReadonlyArray<FakeModelMessage>;
}

/**
 * Chooses the reply to one completion request. `asked` is the request's
 * number on this server, counting from 1.
 */
export type FakeModelScript = (request: FakeModelRequest, asked: number) => FakeModelReply;

export interface FakeModelServer {
  /** The URL to put in a provider's `baseUrl` in `models.json`. */
  readonly baseUrl: string;
  /** Returns how many completions pi has requested so far. */
  readonly asked: () => number;
  /** Returns the body of every completion request pi has sent so far, in order. */
  readonly requests: () => ReadonlyArray<string>;
  readonly stop: () => void;
}

/** The default command the fake model runs, and the text it prints. */
export const PARKED_COMMAND = "echo parked";

export const PARKED_OUTPUT = "parked";

/**
 * Returns the text of a message: the string itself, or its `text` parts
 * joined. Returns an empty string for a message with no text.
 */
export const readMessageText = (message: FakeModelMessage): string => {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part: unknown) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("");
};

/**
 * Returns the text of the request's first user message, which tells apart the
 * pi processes that share one server: each starts its conversation with its
 * own first input. Returns an empty string when there is no user message.
 */
export const readFirstUserText = (request: FakeModelRequest): string => {
  const first = request.messages.find((message) => message.role === "user");
  return first === undefined ? "" : readMessageText(first);
};

/** Checks whether the request's last message is a tool result, so the model has a tool's answer. */
export const endsWithToolResult = (request: FakeModelRequest): boolean =>
  request.messages.at(-1)?.role === "tool";

/** Builds the script `startFakeModelServer` uses: tool calls first, then text. */
const buildDefaultScript =
  (firstTurn: FakeModelFirstTurn): FakeModelScript =>
  (_request, asked) =>
    asked === 1
      ? {
          toolCalls: [
            ...(firstTurn.writes === undefined
              ? []
              : [{ name: "write", args: { path: firstTurn.writes, content: "written\n" } }]),
            { name: "bash", args: { command: firstTurn.command ?? PARKED_COMMAND } },
          ],
        }
      : { text: "Done." };

const formatChunk = (fields: Record<string, unknown>): string =>
  `data: ${JSON.stringify({
    id: "chatcmpl-hercule",
    object: "chat.completion.chunk",
    created: 1789373122,
    model: "fake-model",
    ...fields,
  })}\n\n`;

const formatChoiceChunk = (choice: Record<string, unknown>): string =>
  formatChunk({ choices: [{ index: 0, ...choice }] });

/**
 * Formats a reply as the SSE body pi reads. `asked` makes every tool call id
 * unique on this server: two calls in one message, or calls of two pi
 * processes, must never share an id.
 */
const formatReply = (reply: FakeModelReply, asked: number): string =>
  [
    formatChoiceChunk({ delta: { role: "assistant", content: "" }, finish_reason: null }),
    "toolCalls" in reply
      ? formatChoiceChunk({
          delta: {
            tool_calls: reply.toolCalls.map((call, index) => ({
              index,
              id: `call_hercule_${asked}_${index}_${call.name}`,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            })),
          },
          finish_reason: null,
        })
      : formatChoiceChunk({ delta: { content: reply.text }, finish_reason: null }),
    formatChoiceChunk({ delta: {}, finish_reason: "toolCalls" in reply ? "tool_calls" : "stop" }),
    ...(reply.usage === undefined
      ? []
      : [
          formatChunk({
            choices: [],
            usage: {
              prompt_tokens: reply.usage.promptTokens,
              completion_tokens: reply.usage.completionTokens,
              total_tokens: reply.usage.promptTokens + reply.usage.completionTokens,
            },
          }),
        ]),
    "data: [DONE]\n\n",
  ].join("");

/** Starts a fake model server whose replies the given script chooses. */
export const startScriptedModelServer = (script: FakeModelScript): FakeModelServer => {
  let asked = 0;
  const requests: Array<string> = [];
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
      const body = await request.text();
      requests.push(body);
      asked += 1;
      const reply = script(JSON.parse(body) as FakeModelRequest, asked);
      return new Response(formatReply(reply, asked), {
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
    requests: () => requests,
    stop: () => void server.stop(true),
  };
};

/** Starts a fake model server with the default script: one tool call batch, then text. */
export const startFakeModelServer = (firstTurn: FakeModelFirstTurn = {}): FakeModelServer =>
  startScriptedModelServer(buildDefaultScript(firstTurn));

/**
 * Writes a `models.json` that points the `zai` provider at the fake model
 * server, so the adapter's `--model zai/<slug>` reaches it. The built-in
 * models stay; `fake-model` is added beside them.
 */
export const pointAtFakeModel = (home: string, baseUrl: string): void => {
  writeFileSync(
    join(home, "models.json"),
    JSON.stringify({
      providers: {
        zai: {
          baseUrl,
          api: "openai-completions",
          apiKey: "not-a-real-key",
          models: [
            {
              id: "fake-model",
              name: "Fake model",
              reasoning: true,
              input: ["text"],
              contextWindow: 100_000,
              maxTokens: 4_096,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
};
