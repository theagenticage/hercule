/**
 * The scripted model of the real-pi MCP tests. It plays an agent that finds a
 * tool of the MCP Gateway with pi's `tool_search`, the only way pi shows the
 * model a gateway tool, and then calls the tool the search returned.
 *
 * A prompt tells it what to do:
 *
 * - `find <word>`: call the tool whose name holds `<word>`. When pi has not
 *   declared such a tool yet, search for `<word>` first and call the tool the
 *   search returned. A tool pi already declared is called without a search.
 * - `delegate <word>`: start a subagent whose brief is `find <word>`.
 *
 * Any other request, and any tool result that follows a call, ends the turn
 * with text.
 */
import { MCP_GATEWAY_HARNESS_PREFIX } from "@hercule/protocol";
import { SUBAGENT_TOOL } from "./extension";
import {
  readRequestMessageText,
  type FakeModelReply,
  type FakeModelRequest,
  type FakeModelScript,
} from "./upstream";

/** The name of pi's own tool for finding MCP tools. */
export const TOOL_SEARCH_TOOL = "tool_search";

/** Returns the text of the last user message in the request, or an empty string when there is none. */
const readLastUserText = (request: FakeModelRequest): string => {
  const last = request.messages.findLast((message) => message.role === "user");
  return last === undefined ? "" : readRequestMessageText(last);
};

/** Returns the name of the tool the last assistant message called, or `undefined` when it called none. */
const readLastCalledTool = (request: FakeModelRequest): string | undefined =>
  request.messages.findLast((message) => message.role === "assistant")?.tool_calls?.[0]?.function
    .name;

/** Returns the names of the gateway's tools in a `tool_search` result, in the order pi listed them. */
const readFoundTools = (result: string): ReadonlyArray<string> =>
  [...result.matchAll(/^- (mcp__\S+?):/gm)].map((match) => match[1]!);

const buildToolCall = (name: string, args: Record<string, string>): FakeModelReply => ({
  toolCalls: [{ name, args }],
});

/** Builds the script. Each test builds its own, though it holds no state. */
export const buildMcpCallScript =
  (): FakeModelScript =>
  (request): FakeModelReply => {
    const last = request.messages.at(-1);
    if (last?.role === "user") {
      const prompt = readRequestMessageText(last);
      const delegated = /^delegate (.+)$/.exec(prompt)?.[1];
      if (delegated !== undefined) {
        return buildToolCall(SUBAGENT_TOOL, {
          description: "look it up",
          prompt: `find ${delegated}`,
        });
      }
      const wanted = /^find (.+)$/.exec(prompt)?.[1];
      if (wanted === undefined) return { text: "There is nothing to do." };
      const declared = (request.tools ?? [])
        .map((tool) => tool.function.name)
        .find((name) => name.startsWith(MCP_GATEWAY_HARNESS_PREFIX) && name.includes(wanted));
      return declared === undefined
        ? buildToolCall(TOOL_SEARCH_TOOL, { query: wanted })
        : buildToolCall(declared, { text: "hello" });
    }
    if (last?.role === "tool" && readLastCalledTool(request) === TOOL_SEARCH_TOOL) {
      const wanted = /^find (.+)$/.exec(readLastUserText(request))?.[1] ?? "";
      const found = readFoundTools(readRequestMessageText(last));
      const chosen = found.find((name) => name.includes(wanted)) ?? found[0];
      return chosen === undefined
        ? { text: "The search found no tool." }
        : buildToolCall(chosen, { text: "hello" });
    }
    return { text: "Done." };
  };
