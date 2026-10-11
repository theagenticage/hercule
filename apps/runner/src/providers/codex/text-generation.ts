/**
 * The Codex side of a text generation: one model call on a Codex thread with
 * no tools, no workspace and nothing saved (spec 06 section 14). This file
 * builds the thread and turn requests, watches the app-server's notifications
 * until the turn ends, and turns what happened into a `TextGenerationOutcome`.
 * The adapter owns the process; this file owns what is sent to it and what is
 * made of its answer.
 */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { TextGenerationOutcome, TextGenerationSpec, Usage } from "@hercule/protocol";
import { judgeAnswer } from "../structured-result";
import { truncateMessage } from "../text";
import { readHarnessAnswer, readTotalUsage } from "./normalize";
import type { NotificationFrame } from "./rpc";
import type {
  ItemCompletedNotification,
  ItemStartedNotification,
  JsonValue,
  ThreadItem,
  ThreadStartParams,
  ThreadTokenUsageUpdatedNotification,
  TurnCompletedNotification,
  TurnStartParams,
} from "./types";

/**
 * The thread settings that turn Codex's tools off, sent as `config` on
 * `thread/start`. Codex rejects a key it does not know, so a setting renamed
 * in an upgrade fails the call instead of leaving a tool on.
 *
 * This list is the complete set of tools-off settings on its own. Two of its
 * keys, `features.plugins` and `skills.bundled.enabled`, are also in
 * `TEXT_GENERATION_PROCESS_OVERRIDES`, because the process reads them at
 * startup, before any thread exists.
 *
 * - `features.shell_tool` removes the shell commands.
 * - `features.view_image` removes the image viewer.
 * - `web_search` removes web search.
 * - `features.multi_agent` removes subagents and the tool search that finds
 *   them. `features.apps` and `features.plugins` remove connectors and plugin
 *   tools, which would add tools from the user's account.
 * - `features.image_generation` removes image generation.
 * - `skills.bundled.enabled` stops Codex from adding a list of its built-in
 *   skills (about 6 KB) to the context of every call, which a text generation
 *   would pay for and never use.
 * - `include_environment_context` stops Codex from describing the working
 *   directory and shell to the model: there is no workspace to describe.
 *
 * The pinned Codex cannot remove four tools. `apply_patch` and
 * `request_user_input` have no setting. `exec` and `wait` come from the
 * model's own catalog entry (`tool_mode: code_mode_only`, as for
 * `gpt-5.6-luna`), which no setting overrides. With the shell and the image
 * viewer off, `exec` runs JavaScript in an isolate that has no file system,
 * no network and no shell, and the only tool it can call is `apply_patch`.
 * A call that uses any of the four fails (see `watchTextGeneration`), and
 * the read-only sandbox and the never-ask policy mean Codex would not run a
 * patch anyway. There are no MCP servers to turn off:
 * the instance's Codex directory is Hercule's own and defines none.
 */
const TOOLS_OFF: Readonly<Record<string, JsonValue>> = {
  "features.shell_tool": false,
  "features.view_image": false,
  "features.multi_agent": false,
  "features.apps": false,
  "features.plugins": false,
  "features.image_generation": false,
  web_search: "disabled",
  "skills.bundled.enabled": false,
  include_environment_context: false,
};

/**
 * The `-c` arguments for the app-server process of a text generation. They
 * turn off what Codex does while it starts, before any thread exists, so the
 * thread settings cannot reach it:
 *
 * - `features.plugins` stops the download of plugins into the Codex directory.
 * - `features.shell_snapshot` stops the shell snapshot written there.
 * - `features.memories` stops Codex from reading and writing its memories.
 * - `skills.bundled.enabled` stops it from unpacking its built-in skills there.
 *
 * A text generation has no use for any of them, and each costs time and disk
 * on every call, because every call starts a new process.
 */
export const TEXT_GENERATION_PROCESS_OVERRIDES: ReadonlyArray<string> = [
  "-c",
  "features.plugins=false",
  "-c",
  "features.shell_snapshot=false",
  "-c",
  "features.memories=false",
  "-c",
  "skills.bundled.enabled=false",
];

/**
 * Builds the `thread/start` request for a text generation. The thread is
 * ephemeral, so Codex writes no session file for it. It runs in `scratchDir`,
 * a directory made for this call alone, in a read-only sandbox and never asks
 * for approval.
 */
export const buildTextGenerationThread = (
  spec: TextGenerationSpec,
  scratchDir: string,
): ThreadStartParams => ({
  cwd: scratchDir,
  model: spec.model,
  baseInstructions: spec.instructions,
  ephemeral: true,
  approvalPolicy: "never",
  sandbox: "read-only",
  config: { ...TOOLS_OFF },
});

/**
 * Builds the `turn/start` request for a text generation: the input as the one
 * user message, and the output schema Codex constrains the answer to.
 *
 * The effort is `low`, the lowest every model Codex lists accepts. A text
 * generation is a small, cheap call, and the controller sends no model
 * options. A model that does not accept `low` fails the turn with Codex's own
 * message, which the call reports as a failure.
 */
export const buildTextGenerationTurn = (
  threadId: string,
  spec: TextGenerationSpec,
): TurnStartParams => ({
  threadId,
  input: [{ type: "text", text: spec.input, text_elements: [] }],
  effort: "low",
  // The schema crosses the wire as the JSON the controller sent, and Codex's
  // own JSON type is the mutable type ts-rs writes.
  outputSchema: spec.outputSchema as JsonValue,
});

/** How a text generation ended, before its answer is judged. */
export type TextGenerationEnd =
  | {
      readonly kind: "answered";
      readonly last: ThreadItem | undefined;
      readonly usage: Usage | null;
    }
  | { readonly kind: "failed"; readonly message: string };

/** The item types a one-shot answer may contain. Every other item is a tool call. */
const ANSWER_ITEM_TYPES: ReadonlySet<string> = new Set([
  "userMessage",
  "agentMessage",
  "reasoning",
]);

/** A text generation being watched: feed it what the app-server sends. */
export interface TextGenerationWatch {
  /** Takes a notification from the app-server. */
  readonly receive: (frame: NotificationFrame) => void;
  /** Takes a request the app-server sent and expects a reply to. It is always a tool call or a question. */
  readonly receiveRequest: (method: string) => void;
  /** Tells the watch that the app-server exited. */
  readonly serverExited: () => void;
  /** Succeeds with how the call ended, once the turn has ended or the call has failed. */
  readonly ended: Effect.Effect<TextGenerationEnd>;
}

/**
 * Starts watching a text generation's thread. The call ends at the first of:
 *
 * - the turn completes: the last item is judged against the schema;
 * - the model starts any item that is not a message, which is a tool call, or
 *   the app-server asks for approval or for an answer from a person: the call
 *   fails at once, with no answer judged. A text generation allows no tools
 *   and has nobody to ask, so a model that tries has not followed its
 *   instructions;
 * - the turn fails or is interrupted, or the app-server exits.
 *
 * The first end wins; later frames change nothing. `decideTextGenerationOutcome` turns the
 * end into the call's outcome.
 */
export const watchTextGeneration = (): TextGenerationWatch => {
  const finished = Deferred.makeUnsafe<TextGenerationEnd>();
  let last: ThreadItem | undefined;
  let usage: Usage | null = null;

  const finish = (result: TextGenerationEnd): void => {
    Deferred.doneUnsafe(finished, Effect.succeed(result));
  };
  return {
    receive: (frame) => {
      switch (frame.method) {
        case "item/started": {
          const { item } = frame.params as ItemStartedNotification;
          if (!ANSWER_ITEM_TYPES.has(item.type)) {
            finish({
              kind: "failed",
              message: `the model tried to use a tool (${item.type}), and a text generation allows none`,
            });
          }
          return;
        }
        case "item/completed":
          last = (frame.params as ItemCompletedNotification).item;
          return;
        case "thread/tokenUsage/updated":
          usage =
            readTotalUsage((frame.params as ThreadTokenUsageUpdatedNotification).tokenUsage) ??
            usage;
          return;
        case "turn/completed": {
          const { turn } = frame.params as TurnCompletedNotification;
          if (turn.status === "completed") finish({ kind: "answered", last, usage });
          else
            finish({
              kind: "failed",
              message: truncateMessage(
                turn.error?.message ?? `the turn ended as ${turn.status} with no error`,
              ),
            });
          return;
        }
      }
    },
    receiveRequest: (method) =>
      finish({
        kind: "failed",
        message: `the model asked for ${method}, and a text generation allows no tools and has nobody to ask`,
      }),
    serverExited: () =>
      finish({ kind: "failed", message: "the codex app-server exited before the turn ended" }),
    ended: Deferred.await(finished),
  };
};

/**
 * Turns a finished text generation into its outcome. An answer is parsed as
 * JSON exactly as written and checked against the output schema: the value is
 * checked here even though Codex was told the schema, because a harness
 * checking its own answer would be marking its own work.
 *
 * - A valid answer is `ok`, with the tokens the thread used.
 * - A final message that is missing, is not JSON or breaks the schema is
 *   `invalid-output`, with a short reason.
 * - A call that did not end in an answer is `failed`.
 */
export const decideTextGenerationOutcome = (
  spec: TextGenerationSpec,
  end: TextGenerationEnd,
): TextGenerationOutcome => {
  if (end.kind === "failed") return { outcome: "failed", message: end.message };
  const judged = judgeAnswer(spec.outputSchema, readHarnessAnswer(end.last));
  return judged.outcome === "ok"
    ? { outcome: "ok", value: judged.value, usage: end.usage }
    : { outcome: "invalid-output", reason: judged.reason };
};
