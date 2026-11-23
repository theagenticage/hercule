/**
 * The form of the Add by URL dialog and of the token form: what each field
 * shows, what the form sends, and which field a refusal belongs to. The
 * apps draw what these return and decide nothing about it.
 *
 * The controller decides what an address, a name and a token are worth. The
 * rules mirrored here (the suggested name, the checks of a typed name and
 * token) only let the form say so before it sends.
 */
import {
  McpServerName,
  McpServerToken,
  listDecodeIssues,
  type Issue,
  type McpServer,
} from "@hercule/contract";
import { Schema } from "effect";
import { readValidationIssues } from "../errors";
import { BROWSER_SIGN_IN_LABEL, offersBrowserSignIn } from "./sign-in-words";
import type { TextPart } from "./project-boxes";
import type { FlowProblem, UrlServerFlowState } from "./url-server-flows";

/** The host labels that say what a server is and not whose it is, so they never name a server. */
const GENERIC_HOST_LABELS: readonly string[] = ["mcp", "www", "api"];

const isServerName = Schema.is(McpServerName);

/**
 * Returns the name the Name field suggests for `address`, or `null` when none
 * can be made yet (the text is not an http or https address, or its host has
 * no usable label).
 *
 * This is a preview of the rule the controller applies when `mcpServer.create`
 * gets no name, which clients cannot import (its `buildDefaultServerName`).
 * The name is the first label of the host that is not `mcp`, `www` or `api`,
 * with each run of characters outside `a-z` and `0-9` turned into one `_`, the
 * `_` at either end removed, cut to 16 characters and trimmed of a trailing
 * `_` again. `https://mcp.notion.com/mcp` gives `notion`. The suggestion is
 * never sent (see `readAddForm`), so the controller's rule decides the name
 * even where this copy differs.
 */
export const suggestServerName = (address: string): string | null => {
  const text = address.trim();
  if (!URL.canParse(text)) return null;
  const { protocol, hostname } = new URL(text);
  if (protocol !== "http:" && protocol !== "https:") return null;
  // The controller removes a trailing dot of the host before it builds the name.
  const label = hostname
    .replace(/\.+$/, "")
    .split(".")
    .find((each) => !GENERIC_HOST_LABELS.includes(each));
  const name = (label ?? "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 16)
    .replace(/_+$/, "");
  return isServerName(name) ? name : null;
};

/**
 * Returns the line under the Name field: "Agents see its tools as
 * `mcp__tools__<name>__<tool>`", with the code span holding the name shown so
 * far, or `<name>` while the field is empty.
 */
export const describeToolNamePreview = (name: string): readonly TextPart[] => [
  { text: "Agents see its tools as ", code: false },
  { text: `mcp__tools__${name === "" ? "<name>" : name}__<tool>`, code: true },
];

/**
 * The line under the Address field of the Add by URL form. The address is
 * shown whole everywhere, so a key written into it would be too: the line
 * says a key goes in the token field, which the next step shows.
 */
export const ADDRESS_FIELD_HINT =
  "A remote MCP server, reached over HTTPS. The controller calls it, so it must be reachable from there. If it needs a key, leave it out of the address: the next step asks for it in a token field.";

const NAME_RULE =
  "A name holds lowercase letters, digits and single _ between them, 1 to 16 characters, and is not hercule.";

/** What the Add by URL form shows and sends for the text in its two fields. */
export interface AddFormReading {
  /** What the Name field shows: the typed name, else the suggestion, else empty. */
  readonly name: string;
  /** The line under the Name field, for `name`. */
  readonly preview: readonly TextPart[];
  /** Why the typed name breaks the name rule, or `null`. A suggestion never has an issue. */
  readonly nameIssue: string | null;
  /**
   * The name `mcpServer.create` gets, or `undefined` to leave it out. Only a
   * name the user typed is sent: with the suggestion untouched, the controller
   * decides, so a difference between its rule and the preview never gives the
   * user a name they did not see typed.
   */
  readonly createName: string | undefined;
  /** The address `mcpServer.create` gets: the text, trimmed. */
  readonly createAddress: string;
  /** Whether "Check server" can send: an address is typed and the typed name, if any, follows the rule. */
  readonly canSubmit: boolean;
}

/**
 * Reads the Add by URL form from its two fields. `typedName` is what the user
 * typed in the Name field, or `null` while they never touched it, which is
 * not the same as an empty text: the app keeps it while the address changes,
 * so a typed name survives address edits and an untouched one follows them. A
 * typed name that is blank counts as untouched.
 *
 * It never refuses an address, and it does not require https: the contract
 * accepts http, and the form's hint about https stays a hint.
 */
export const readAddForm = ({
  address,
  typedName,
}: {
  readonly address: string;
  readonly typedName: string | null;
}): AddFormReading => {
  const typed = typedName?.trim() ?? "";
  const name = typed === "" ? (suggestServerName(address) ?? "") : typed;
  const nameIssue = typed !== "" && !isServerName(typed) ? NAME_RULE : null;
  const createAddress = address.trim();
  return {
    name,
    preview: describeToolNamePreview(name),
    nameIssue,
    createName: typed === "" ? undefined : typed,
    createAddress,
    canSubmit: createAddress !== "" && nameIssue === null,
  };
};

/** What the token form shows for the token typed in its field. */
export interface TokenFieldReading {
  /** Why the token cannot be sent (the contract's own sentence), or `null`. An empty field has no issue yet: it only cannot be sent. */
  readonly issue: string | null;
  readonly canSubmit: boolean;
}

/**
 * Reads the token field. The text is checked against the contract's token
 * rule, which the controller applies too, so a token it would refuse is never
 * sent.
 */
export const readTokenField = (token: string): TokenFieldReading => {
  if (token === "") return { issue: null, canSubmit: false };
  try {
    Schema.decodeUnknownSync(McpServerToken)(token);
    return { issue: null, canSubmit: true };
  } catch (error) {
    if (!(error instanceof Schema.SchemaError)) throw error;
    return {
      issue: listDecodeIssues(error)[0]?.message ?? "This token is not valid.",
      canSubmit: false,
    };
  }
};

/** Where the controller's `validation` issues of a create or a token write go in the form. */
export interface FieldIssues {
  /** The reason the address was refused (path `source.url`), or `null`. */
  readonly address: string | null;
  /** The reason the name was refused (path `source.name`), or `null`. */
  readonly name: string | null;
  /** The reason the token was refused (path `token`), or `null`. */
  readonly token: string | null;
  /** Every other reason, joined, for the form as a whole, or `null`. */
  readonly other: string | null;
}

/**
 * Sorts the issues of a `validation` error by the field they are about, or
 * returns `undefined` when `error` is not a `validation` error. A reason with
 * no field of the form goes to `other`, so nothing the controller said is
 * dropped.
 */
export const readFieldIssues = (error: unknown): FieldIssues | undefined => {
  const issues = readValidationIssues(error);
  if (issues === undefined) return undefined;
  const messageAt = (field: string): string | null => {
    const found = issues.filter((issue) => issue.path.join(".") === field);
    return found.length === 0 ? null : found.map((issue) => issue.message).join(" ");
  };
  const known = new Set(["source.url", "source.name", "token"]);
  const rest = issues.filter((issue: Issue) => !known.has(issue.path.join(".")));
  return {
    address: messageAt("source.url"),
    name: messageAt("source.name"),
    token: messageAt("token"),
    other: rest.length === 0 ? null : rest.map((issue) => issue.message).join(" "),
  };
};

/**
 * The button the user pressed to open the sign-in dialog of a server added by
 * URL. It decides what the dialog opens with, so a record that changes
 * between the press and the dialog's first read does not change the user's
 * choice:
 *
 * - `replace-token`: the page's "Replace token…", which opens on the token field.
 * - `sign-in-again`: the page's "Sign in again…", which opens on the browser.
 * - `sign-in`: any other "Sign in…" (the status band, a thread's line or menu),
 *   which opens on what the record says (see `describeTokenForm`).
 */
export type SignInEntry = "replace-token" | "sign-in-again" | "sign-in";

/** The words of the token form for one server. */
export interface TokenFormWords {
  /** The sentence over the field: what the server asks for. For a server that signs in through the browser, the pasted token is the other way. */
  readonly intro: string;
  /**
   * The browser sign-in the form offers first, or `null` for a server that
   * has none. `intro` of the browser choice, the primary `label`, and the
   * quiet button `pasteToggle` that shows the token field.
   */
  readonly browser: {
    readonly intro: string;
    readonly label: typeof BROWSER_SIGN_IN_LABEL;
    readonly pasteToggle: "Paste a token instead";
  } | null;
  /**
   * What the form opens with. `browser` shows the browser choice first, with
   * the token field behind "Paste a token instead". `token` shows the token
   * field. A form that has a problem to show and one that cannot sign in
   * through the browser open with `token`. Otherwise the entry decides:
   * "Replace token…" opens with `token` and "Sign in again…" with `browser`;
   * any other entry opens with `token` for a server that holds a pasted token
   * (a refused token), and with `browser` for a server that holds none and
   * offers one.
   */
  readonly method: "browser" | "token";
  /** The reason to show with the token field for the last write's `problem`, or `undefined`. */
  readonly problemText: string | undefined;
  /** The line under the field. */
  readonly note: "Kept on the controller. It never reaches a runner.";
  /** The sentence that says checking waits, or `null` while the server is switched on. */
  readonly offNote: string | null;
  readonly submitLabel: "Save token";
}

/**
 * Returns the heading of the sign-in dialog of `server`, a server added by
 * URL: "Sign in to docs" for a server that needs sign-in or signs in through
 * the browser, else "Replace the token of docs".
 */
export const describeSignInHeading = (server: McpServer): string =>
  server.status === "needs-sign-in" || offersBrowserSignIn(server)
    ? `Sign in to ${server.name}`
    : `Replace the token of ${server.name}`;

/**
 * Returns the text to show beside the token field for the problem of the last
 * token write: the controller's reason for the token, any other reason, or the
 * failure's own message. `undefined` when there is none. The refusals of a
 * create (`exists`, `plugin-origin`) never answer a token write.
 */
const describeTokenProblem = (problem: FlowProblem | null): string | undefined => {
  switch (problem?.kind) {
    case "invalid":
      return (
        [problem.issues.token, problem.issues.other].filter((text) => text !== null).join(" ") ||
        undefined
      );
    case "failed":
    case "sign-in-unsupported":
      return problem.message;
    default:
      return undefined;
  }
};

/**
 * Returns the `SignInEntry` the token form of a dialog is drawn with, given
 * the dialog's `state` and `openedWith`, the button that opened it. The button
 * decides the first form only. Once the attempt wrote and the check refused
 * what it wrote, the form leads from the way that was written, whatever the
 * button was:
 *
 * - a pasted token that was refused leads to the token field (`replace-token`);
 * - a sign-in through the browser that was refused leads to the browser choice
 *   (`sign-in-again`).
 */
export const decideTokenFormEntry = (
  state: UrlServerFlowState,
  openedWith: SignInEntry,
): SignInEntry => {
  if (state.kind !== "following" || state.outcome.kind !== "needs-token") return openedWith;
  switch (state.outcome.refusedWrite) {
    case "token":
      return "replace-token";
    case "sign-in":
      return "sign-in-again";
    case null:
      return openedWith;
  }
};

/** Returns the method a token form opens with: see `TokenFormWords.method`. */
const decideFirstMethod = ({
  asksForOAuth,
  holdsToken,
  hasProblem,
  entry,
}: {
  readonly asksForOAuth: boolean;
  readonly holdsToken: boolean;
  readonly hasProblem: boolean;
  readonly entry: SignInEntry;
}): "browser" | "token" => {
  if (!asksForOAuth || hasProblem || entry === "replace-token") return "token";
  if (entry === "sign-in-again") return "browser";
  return holdsToken ? "token" : "browser";
};

/**
 * Returns the words of the token form for `server`, a server added by URL.
 * Add, the page's "Replace token…" and the "Sign in…" of a thread line and of
 * the band all draw these words.
 *
 * - A server that signs in through the browser: the browser is the primary
 *   choice (`browser`), and the pasted token the other way, which `intro`
 *   words as one. It never calls pasting a token signing in.
 * - A server that holds a pasted token and needs sign-in: the token was
 *   refused, so "The server refused its token. Paste a new one." and the
 *   token field first, even when the server offers the browser.
 * - A server that holds a token and does not need sign-in (Replace token…):
 *   the new token replaces the old, in the token field first.
 * - A server that offers the browser and holds no token: the browser choice
 *   first (`method` is `browser`).
 * - A server that needs a token: "This server needs a token."
 *
 * `problem` is what the last write of the form left (`FlowProblem`). When it
 * says only a pasted token works, the browser choice is dropped (`browser` is
 * `null`), and any problem puts the token field first. `entry` is the button
 * that opened the dialog (`SignInEntry`): the first step follows it, whatever
 * the record says by the time the dialog reads it. A form that follows a
 * refused write gets its entry from `decideTokenFormEntry`.
 */
export const describeTokenForm = (
  server: McpServer,
  problem: FlowProblem | null = null,
  entry: SignInEntry = "sign-in",
): TokenFormWords => {
  const { source } = server;
  const holdsToken = source.kind === "url" && source.signIn === "token";
  const asksForOAuth = offersBrowserSignIn(server) && problem?.kind !== "sign-in-unsupported";
  const needsSignIn = server.status === "needs-sign-in";
  const problemText = describeTokenProblem(problem);
  const intro = holdsToken
    ? needsSignIn
      ? "The server refused its token. Paste a new one."
      : "Paste a new token. It replaces the one this server holds."
    : asksForOAuth
      ? "Paste a token, if the service gives you one."
      : needsSignIn
        ? "This server needs a token."
        : "Paste a new token. It replaces the one this server holds.";
  return {
    intro,
    method: decideFirstMethod({
      asksForOAuth,
      holdsToken,
      hasProblem: problemText !== undefined,
      entry,
    }),
    problemText,
    browser: asksForOAuth
      ? {
          intro: "This server signs in through your browser.",
          label: BROWSER_SIGN_IN_LABEL,
          pasteToggle: "Paste a token instead",
        }
      : null,
    note: "Kept on the controller. It never reaches a runner.",
    offNote: server.enabled
      ? null
      : "This server is switched off. The token is saved, and checking runs when it is switched on.",
    submitLabel: "Save token",
  };
};
