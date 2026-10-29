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
 * A converter throws when a block is not the shape the SDK promises: a nested
 * `type` it does not know, or a field it reads that is missing or of another
 * type. The caller turns that into a failed row for the call, or a labelled
 * `unknown` item when the call was never seen.
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { requireText, truncateFact, truncateMessage, truncateWithMarker } from "./text";

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

const buildSucceededResult = (content: string): ConvertedResult => ({
  failed: false,
  content: truncateMessage(content),
});

/** Returns a failed result that names the tool and the error code the API gave. */
const buildFailedResult = (tool: string, errorCode: unknown): ConvertedResult => ({
  failed: true,
  content: truncateMessage(`${tool} failed: ${requireText(errorCode, `${tool} error code`)}`),
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
  if (!Array.isArray(hits)) return buildFailedResult("The web search", hits.error_code);
  if (hits.length === 0) return buildSucceededResult("The search found nothing.");
  return buildSucceededResult(
    hits
      .map(
        (hit) =>
          `${requireText(hit.title, "search hit title")}\n${requireText(hit.url, "search hit URL")}`,
      )
      .join("\n\n"),
  );
};

/**
 * Returns the URL a `web_fetch_tool_result` fetched, cut to the length of a
 * fact, or `undefined` when the result is an error or holds no URL.
 */
export const readFetchedPageUrl = (
  block: AssistantBlockFor<"web_fetch_tool_result">,
): string | undefined => {
  const url: unknown = "url" in block.content ? block.content.url : undefined;
  return typeof url === "string" ? truncateFact(url) : undefined;
};

/**
 * Converts a `web_fetch_tool_result`: the page's title and URL, and the start
 * of its text when the page is plain text, or the error.
 */
export const convertWebFetchResult = (
  block: AssistantBlockFor<"web_fetch_tool_result">,
): ConvertedResult => {
  const fetched = block.content;
  if ("error_code" in fetched) return buildFailedResult("The web fetch", fetched.error_code);
  const document = fetched.content;
  const { source } = document;
  let body: string;
  switch (source.type) {
    case "text":
      body = truncateWithMarker(requireText(source.data, "fetched page text"), FETCHED_TEXT_LENGTH);
      break;
    case "base64":
      body = "The page is a PDF document.";
      break;
    default:
      throw new Error("the fetched page has an unknown source type");
  }
  const title = document.title === null ? "" : requireText(document.title, "fetched page title");
  return buildSucceededResult(
    [title, requireText(fetched.url, "fetched page URL"), "", body].join("\n").trim(),
  );
};

/**
 * Builds the result of a command run. A non-zero return code is a failure, and
 * the output stays readable either way. `output` holds the lines that show the
 * run's standard output.
 */
const buildRunResult = (
  run: { readonly return_code: number; readonly stderr: string },
  output: ReadonlyArray<string>,
): ConvertedResult => {
  const { return_code: returnCode } = run;
  if (typeof returnCode !== "number") throw new Error("the return code is not a number");
  const stderr = requireText(run.stderr, "error output");
  return {
    failed: returnCode !== 0,
    content: truncateMessage(
      [
        `Return code: ${returnCode}`,
        ...output,
        ...(stderr === "" ? [] : ["Error output:", stderr]),
      ].join("\n"),
    ),
  };
};

/** Returns the lines that show a command's standard output, none when it is empty. */
const describeStdout = (stdout: unknown): ReadonlyArray<string> => {
  const text = requireText(stdout, "standard output");
  return text === "" ? [] : ["Output:", text];
};

/** Converts a `code_execution_tool_result`: return code, output and error output. */
export const convertCodeExecutionResult = (
  block: AssistantBlockFor<"code_execution_tool_result">,
): ConvertedResult => {
  const run = block.content;
  if ("error_code" in run) return buildFailedResult("The code execution", run.error_code);
  switch (run.type) {
    case "encrypted_code_execution_result":
      return buildRunResult(run, ["The output is encrypted."]);
    case "code_execution_result":
      return buildRunResult(run, describeStdout(run.stdout));
    default:
      throw new Error("the code execution result has an unknown type");
  }
};

/** Converts a `bash_code_execution_tool_result`: return code, output and error output. */
export const convertBashCodeExecutionResult = (
  block: AssistantBlockFor<"bash_code_execution_tool_result">,
): ConvertedResult => {
  const run = block.content;
  if ("error_code" in run) return buildFailedResult("The bash code execution", run.error_code);
  if (run.type !== "bash_code_execution_result") {
    throw new Error("the bash code execution result has an unknown type");
  }
  return buildRunResult(run, describeStdout(run.stdout));
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
  if ("error_code" in edit) return buildFailedResult("The text editor", edit.error_code);
  switch (edit.type) {
    case "text_editor_code_execution_view_result":
      return buildSucceededResult(requireText(edit.content, "viewed text"));
    case "text_editor_code_execution_create_result":
      return buildSucceededResult(
        edit.is_file_update ? "The file was updated." : "The file was created.",
      );
    case "text_editor_code_execution_str_replace_result":
      return buildSucceededResult(
        edit.lines === null
          ? "The text was replaced."
          : edit.lines.map((line) => requireText(line, "replaced line")).join("\n"),
      );
    default:
      throw new Error("the text editor result has an unknown type");
  }
};

/** Converts a `tool_search_tool_result`: the names of the tools it found, or the error. */
export const convertToolSearchResult = (
  block: AssistantBlockFor<"tool_search_tool_result">,
): ConvertedResult => {
  const search = block.content;
  if ("error_code" in search) return buildFailedResult("The tool search", search.error_code);
  if (!Array.isArray(search.tool_references)) throw new Error("the tool references are not a list");
  const names = search.tool_references.map((reference) =>
    requireText(reference.tool_name, "tool name"),
  );
  return buildSucceededResult(
    names.length === 0 ? "No tools were found." : `Found tools: ${names.join(", ")}`,
  );
};

/** Converts an `advisor_tool_result`: the advice, or a sentence when the advice is encrypted. */
export const convertAdvisorResult = (
  block: AssistantBlockFor<"advisor_tool_result">,
): ConvertedResult => {
  const advice = block.content;
  if ("error_code" in advice) return buildFailedResult("The advisor", advice.error_code);
  switch (advice.type) {
    case "advisor_redacted_result":
      return buildSucceededResult("The advice is encrypted.");
    case "advisor_result":
      return buildSucceededResult(requireText(advice.text, "advice"));
    default:
      throw new Error("the advisor result has an unknown type");
  }
};

/** Converts an `mcp_tool_result`: its text as it is, failed when the server flagged an error. */
export const convertMcpResult = (block: AssistantBlockFor<"mcp_tool_result">): ConvertedResult => ({
  failed: block.is_error === true,
  content: truncateResultContent(block.content),
});
