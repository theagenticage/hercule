/**
 * Converts the result blocks of a Claude assistant message into the text a
 * client shows. A tool that runs on Anthropic's servers (web search, web fetch,
 * code execution, ...) and an MCP call made through the API connector return
 * their result as a content block of an assistant message, in a shape of its
 * own for each tool. A client must not need to know those shapes, so the runner
 * writes each one as readable text (spec 06 section 6.3).
 *
 * The converters read only what a person would want to see. They leave out
 * `encrypted_content` and other opaque data. The vendor's whole block stays in
 * the event's `raw`.
 *
 * A converter throws when a block is not the shape the SDK promises. The caller
 * turns that into a labelled `unknown` item.
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { truncateMessage, truncateWithMarker } from "./text";

/** One content block of a Claude assistant message. */
export type AssistantBlock = Extract<
  SDKMessage,
  { type: "assistant" }
>["message"]["content"][number];

/** The block of an assistant message with the given `type`. */
export type AssistantBlockFor<Type extends AssistantBlock["type"]> = Extract<
  AssistantBlock,
  { type: Type }
>;

/** What a result block turns into: whether the call failed, and the `detail.content` to show. */
export interface ConvertedResult {
  readonly failed: boolean;
  readonly content: unknown;
}

/**
 * The most characters of a fetched plain text document shown in the result.
 * The page can be megabytes long, and the user only needs to recognize it.
 */
const FETCHED_TEXT_LENGTH = 2_000;

const succeed = (content: string): ConvertedResult => ({
  failed: false,
  content: truncateMessage(content),
});

/** Returns a failed result that names the tool and the error code the API gave. */
const fail = (tool: string, errorCode: string): ConvertedResult => ({
  failed: true,
  content: truncateMessage(`${tool} failed: ${errorCode}`),
});

/**
 * Returns a tool result's `content` ready for `detail.content`: a text is cut
 * to the protocol's bound, because a `Read` of a big file returns it whole, and
 * a list of blocks is passed on as it is. `raw` keeps the whole text.
 */
export const truncateResultContent = (content: unknown): unknown =>
  typeof content === "string" ? truncateMessage(content) : content;

/** Converts a `web_search_tool_result`: one title and URL per hit, or the error. */
export const convertWebSearchResult = (
  block: AssistantBlockFor<"web_search_tool_result">,
): ConvertedResult => {
  const hits = block.content;
  if (!Array.isArray(hits)) return fail("The web search", hits.error_code);
  if (hits.length === 0) return succeed("The search found nothing.");
  return succeed(hits.map((hit) => `${hit.title}\n${hit.url}`).join("\n\n"));
};

/**
 * Converts a `web_fetch_tool_result`: the page's title and URL, and the start
 * of its text when the page is plain text, or the error.
 */
export const convertWebFetchResult = (
  block: AssistantBlockFor<"web_fetch_tool_result">,
): ConvertedResult => {
  const fetched = block.content;
  if ("error_code" in fetched) return fail("The web fetch", fetched.error_code);
  const document = fetched.content;
  const body =
    document.source.type === "text"
      ? truncateWithMarker(document.source.data, FETCHED_TEXT_LENGTH)
      : "The page is a PDF document.";
  return succeed([document.title ?? "", fetched.url, "", body].join("\n").trim());
};

/** Lists a command's return code, its output and its error output. */
const describeRun = (
  run: { readonly return_code: number; readonly stderr: string },
  output: ReadonlyArray<string>,
): string =>
  [
    `Return code: ${run.return_code}`,
    ...output,
    ...(run.stderr === "" ? [] : ["Error output:", run.stderr]),
  ].join("\n");

/** Returns the lines that show a command's standard output, none when it is empty. */
const describeStdout = (stdout: string): ReadonlyArray<string> =>
  stdout === "" ? [] : ["Output:", stdout];

/** Converts a `code_execution_tool_result`: return code, output and error output. */
export const convertCodeExecutionResult = (
  block: AssistantBlockFor<"code_execution_tool_result">,
): ConvertedResult => {
  const run = block.content;
  if ("error_code" in run) return fail("The code execution", run.error_code);
  return succeed(
    describeRun(
      run,
      run.type === "encrypted_code_execution_result"
        ? ["The output is encrypted."]
        : describeStdout(run.stdout),
    ),
  );
};

/** Converts a `bash_code_execution_tool_result`: return code, output and error output. */
export const convertBashCodeExecutionResult = (
  block: AssistantBlockFor<"bash_code_execution_tool_result">,
): ConvertedResult => {
  const run = block.content;
  if ("error_code" in run) return fail("The bash code execution", run.error_code);
  return succeed(describeRun(run, describeStdout(run.stdout)));
};

/**
 * Converts a `text_editor_code_execution_tool_result`: the text a view
 * returned, whether a file was created or updated, or the lines a replacement
 * changed.
 */
export const convertTextEditorResult = (
  block: AssistantBlockFor<"text_editor_code_execution_tool_result">,
): ConvertedResult => {
  const edit = block.content;
  if ("error_code" in edit) return fail("The text editor", edit.error_code);
  switch (edit.type) {
    case "text_editor_code_execution_view_result":
      return succeed(edit.content);
    case "text_editor_code_execution_create_result":
      return succeed(edit.is_file_update ? "The file was updated." : "The file was created.");
    case "text_editor_code_execution_str_replace_result":
      return succeed(edit.lines === null ? "The text was replaced." : edit.lines.join("\n"));
  }
};

/** Converts a `tool_search_tool_result`: the names of the tools it found, or the error. */
export const convertToolSearchResult = (
  block: AssistantBlockFor<"tool_search_tool_result">,
): ConvertedResult => {
  const search = block.content;
  if ("error_code" in search) return fail("The tool search", search.error_code);
  const names = search.tool_references.map((reference) => reference.tool_name);
  return succeed(names.length === 0 ? "No tools were found." : `Found tools: ${names.join(", ")}`);
};

/** Converts an `advisor_tool_result`: the advice, or a sentence when the advice is encrypted. */
export const convertAdvisorResult = (
  block: AssistantBlockFor<"advisor_tool_result">,
): ConvertedResult => {
  const advice = block.content;
  if ("error_code" in advice) return fail("The advisor", advice.error_code);
  return succeed(
    advice.type === "advisor_redacted_result" ? "The advice is encrypted." : advice.text,
  );
};

/** Converts an `mcp_tool_result`: its text as it is, failed when the server flagged an error. */
export const convertMcpResult = (block: AssistantBlockFor<"mcp_tool_result">): ConvertedResult => ({
  failed: block.is_error === true,
  content: truncateResultContent(block.content),
});
