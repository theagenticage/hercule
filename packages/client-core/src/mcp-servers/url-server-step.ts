/**
 * What a dialog of a server added by URL draws at each moment: its words and
 * the actions it offers. The web app and the desktop app both draw what
 * `describeUrlServerStep` returns and add no sentence of their own. They place
 * the buttons, the focus and the spacing, and they decide how a link opens
 * (the web app draws the sign-in page as a link, the desktop app asks main to
 * open it).
 */
import type { Connection, McpServer, PluginDetail } from "@hercule/contract";
import {
  decideTokenFormEntry,
  describeSignInHeading,
  describeTokenForm,
  type SignInEntry,
  type TokenFormWords,
} from "./add-by-url";
import {
  describeExistsRefusal,
  describePluginOriginRefusal,
  type RefusalDescription,
} from "./add-refusal";
import type { SignInStep } from "./browser-sign-in";
import type { UrlServerAttemptState, WrittenMethod } from "./url-server-attempt";

/** The dialog an attempt belongs to, as far as its words depend on it. */
export type UrlServerDialog =
  /** Add by URL. `plugins` and `connections` are what the controller says about the plugins and Connections, or `undefined` while they are not read. */
  | {
      readonly kind: "add";
      readonly plugins: readonly PluginDetail[] | undefined;
      readonly connections: readonly Connection[] | undefined;
      /** `here`: the app opens Settings > Plugins. `web-app`: only the web app has that page. */
      readonly pluginsSettings: "here" | "web-app";
    }
  /**
   * The token form of `server`, the record the button was drawn from, which
   * the words use until the attempt has read a newer one. `openedOn` is where
   * the dialog opened: the server's own page, or elsewhere (a thread, the band).
   * `entry` is the button that opened it.
   */
  | {
      readonly kind: "token";
      readonly server: McpServer;
      readonly openedOn: "server-page" | "elsewhere";
      readonly entry: SignInEntry;
    };

/** The button that leads from a dialog to a server's own page. */
export interface OpenServerAction {
  readonly mcpServerId: string;
  /** Such as "Open docs". */
  readonly label: string;
}

/** A button of a step. */
export interface StepButton {
  readonly label: string;
}

/** What every step has. */
interface StepBase {
  /** What closing the dialog now does, or `null` when closing says nothing new. */
  readonly closingNote: string | null;
}

/** The first step of Add: the form, and what the last refusal says in it. */
export interface AddFormStep extends StepBase {
  readonly kind: "add-form";
  /** The refusal of the address, with its button, or `null`. */
  readonly refusal: RefusalDescription | null;
  /** The controller's reason for the address field, or `null`. */
  readonly addressIssue: string | null;
  /** The controller's reason for the name field, or `null`. */
  readonly nameIssue: string | null;
  /** A reason for the form as a whole, or `null`. */
  readonly problemText: string | null;
}

/** The sign-in form: the browser choice or the token field, as `words` says. */
export interface TokenFormStep extends StepBase {
  readonly kind: "token-form";
  /** The server and its address, for a dialog whose title does not name it (Add), or `null`. */
  readonly subject: { readonly name: string; readonly address: string } | null;
  readonly words: TokenFormWords;
  /** The controller's reason when the token or the sign-in just written was refused, or `null`. */
  readonly refusedReason: string | null;
}

/** A wait for the controller, with the one button that can leave it, if any. */
export interface WaitStep extends StepBase {
  readonly kind: "wait";
  readonly text: string;
  /** `close` closes the dialog, `cancel-sign-in` ends the sign-in. `null` while neither is possible. */
  readonly button: ({ readonly kind: "close" | "cancel-sign-in" } & StepButton) | null;
}

/** The sign-in waits for the browser. */
export interface SignInWaitingStep extends StepBase {
  readonly kind: "sign-in-waiting";
  /** "Finish in your browser". */
  readonly heading: string;
  /** Who asks for the approval, such as "You will approve on auth.example.com.". */
  readonly approval: string;
  /** What to do in the browser, and how the sign-in comes back. */
  readonly instruction: string;
  /** The button that opens the sign-in page: "Open the browser", and "Open again" once it was pressed. The host is not in the label, because a long host would not fit a button. `approval` names it. `url` is the page, an http or https address without credentials. */
  readonly open: StepButton & { readonly url: string };
  /** Why the browser could not be opened, as two sentences, or `null`. */
  readonly openError: string | null;
  readonly cancel: StepButton;
  readonly paste: {
    /** True when the paste field is shown whatever the user pressed: it is the only way back, or the last address was refused. */
    readonly alwaysShown: boolean;
    /** The question over the button that shows the paste field, or `null` when the field is always shown or the sign-in page was not opened yet (the browser cannot have come back before it was opened). */
    readonly question: string | null;
    /** The button that shows the paste field, or `null` when `question` is. */
    readonly toggle: string | null;
    readonly label: string;
    readonly submit: string;
    /** Why the last pasted address was not accepted, or `null`. */
    readonly problem: string | null;
  };
}

/** The sign-in ended without a sign-in. */
export interface SignInRefusedStep extends StepBase {
  readonly kind: "sign-in-refused";
  /** Why it ended and what to do. */
  readonly message: string;
  readonly cancel: StepButton;
  readonly startAgain: StepButton;
}

/** The record could not be read, so what the check found is not known. */
export interface ReadFailedStep extends StepBase {
  readonly kind: "read-failed";
  /** "The server could not be read, so what the check found is not known." */
  readonly headline: string;
  /** What to make of it, and the reason the read failed. */
  readonly body: string;
  readonly close: StepButton;
  readonly tryAgain: StepButton;
}

/** The server answered with its tools. */
export interface ReadyStep extends StepBase {
  readonly kind: "ready";
  readonly name: string;
  /** The server's address, or `null` when the record is not read. */
  readonly address: string | null;
  /** "ready · 3 tools". */
  readonly summary: string;
  readonly tools: McpServer["tools"];
  /** What a new server's dialog ends with, or `null`. */
  readonly newServerNote: string | null;
  readonly open: OpenServerAction | null;
  /** "Done". */
  readonly close: StepButton;
}

/** The check ended with `unreachable` or `error`. */
export interface FailedStep extends StepBase {
  readonly kind: "failed";
  /** What the check found, naming the server's host. */
  readonly headline: string;
  /** The controller's reason, or `null`. */
  readonly detail: string | null;
  /** Why the controller refused the last "Check now", or `null`. */
  readonly checkError: string | null;
  readonly close: StepButton;
  readonly checkNow: StepButton & { readonly busy: boolean };
  readonly open: OpenServerAction | null;
}

/** The server is switched off, so it is not checked. */
export interface OffStep extends StepBase {
  readonly kind: "off";
  readonly text: string;
  readonly open: OpenServerAction | null;
  /** "Done". */
  readonly close: StepButton;
}

/** The attempt has nothing left to follow. */
export interface EndedStep extends StepBase {
  readonly kind: "ended";
  readonly headline: string;
  /** The rest of the sentence, or `null`. */
  readonly body: string | null;
  readonly open: OpenServerAction | null;
  readonly close: StepButton;
}

/** The dialog was closed: there is nothing to draw. */
export interface ClosedStep extends StepBase {
  readonly kind: "closed";
}

/** Every step after Add's first form. A token form never shows Add's form, so its steps are all of this kind. */
export type UrlServerLaterStep =
  | TokenFormStep
  | WaitStep
  | SignInWaitingStep
  | SignInRefusedStep
  | ReadFailedStep
  | ReadyStep
  | FailedStep
  | OffStep
  | EndedStep
  | ClosedStep;

export type UrlServerStep = AddFormStep | UrlServerLaterStep;

/** The footer a new server's dialog ends with, under "ready · N tools". */
const NEW_SERVER_NOTE =
  "No project names it yet. A thread gets it from its project's list once a project names it, from the default list when it is named there, or when it is switched on in that thread's composer. Name it in the projects that should use it.";

/** Returns the title of a dialog: "Add an MCP server", or the sign-in heading of the server the token form is for. */
export const describeUrlServerDialogTitle = (dialog: UrlServerDialog): string =>
  dialog.kind === "add" ? "Add an MCP server" : describeSignInHeading(dialog.server);

/** Returns the host of the server's address, or "the server" when it is not read or has no address. */
const readHost = (server: McpServer | null): string =>
  server?.source.kind === "url" && URL.canParse(server.source.url)
    ? new URL(server.source.url).host
    : "the server";

/** Returns what the dialog says of a switched-off server, from what this attempt saved. */
const describeOff = (saved: WrittenMethod | null): string =>
  saved === null
    ? "This server is switched off, so it is not checked."
    : `The ${saved} is saved. This server is switched off, so checking runs when it is switched on.`;

/**
 * Returns what closing the dialog does now, or `null` when it says nothing
 * new. A server stays in the list only in Add, which creates it. A token form
 * never creates a server, so it says nothing of the list.
 */
const describeClosing = (state: UrlServerAttemptState, dialog: UrlServerDialog): string | null => {
  const creates = dialog.kind === "add";
  switch (state.kind) {
    case "writing":
      return state.write === "create"
        ? "The check creates the server. Closing now leaves it in the list, whatever the check finds."
        : "The token is being saved. Closing now does not undo it.";
    case "signing-in":
      if (state.step.kind === "finishing") {
        return "The sign-in is being finished. Closing now does not undo it.";
      }
      return creates
        ? "Closing now ends the sign-in. The server stays in the list."
        : "Closing now ends the sign-in.";
    case "following":
      return creates && state.outcome.kind !== "ready" ? "The server stays in the list." : null;
    case "form":
    case "ended":
      return null;
  }
};

/**
 * Returns the "Open <name>" button of a dialog's outcome, or `null` when there
 * is none. It leads to the server's page, so it is offered when the user is
 * not there and has something to do there:
 *
 * - a dialog opened on the server's own page: never;
 * - elsewhere (Add, a thread): when the check failed, when the server is
 *   switched off, when the server moved onto a Connection, and, for a server
 *   this dialog just created, when it is ready.
 */
const describeOpenServer = (
  state: UrlServerAttemptState,
  dialog: UrlServerDialog,
): OpenServerAction | null => {
  if (dialog.kind === "token" && dialog.openedOn === "server-page") return null;
  if (state.kind === "ended") {
    return state.reason === "moved" && state.mcpServerId !== null
      ? { mcpServerId: state.mcpServerId, label: `Open ${state.name ?? "server"}` }
      : null;
  }
  if (state.kind !== "following") return null;
  const { outcome } = state;
  const leads =
    outcome.kind === "failed" ||
    outcome.kind === "off" ||
    (outcome.kind === "ready" && outcome.newServer);
  return leads
    ? { mcpServerId: state.mcpServerId, label: `Open ${state.server?.name ?? "server"}` }
    : null;
};

/** Returns what an Add refusal says of the token or sign-in the controller's check refused. */
const describeRefusedWrite = (
  refusedWrite: WrittenMethod | null,
  detail: string | null,
): string | null => {
  switch (refusedWrite) {
    case null:
      return null;
    case "token":
      return detail ?? "The server refused this token.";
    case "sign-in":
      return detail ?? "The server did not accept the sign-in.";
  }
};

const readAddress = (server: McpServer): string =>
  server.source.kind === "url" ? server.source.url : "";

/** Describes the step of Add's first form, from the problem the last write left. */
const describeAddForm = (
  state: Extract<UrlServerAttemptState, { kind: "form" }>,
  dialog: Extract<UrlServerDialog, { kind: "add" }>,
): Omit<AddFormStep, "closingNote"> => {
  const { problem } = state;
  const refusal =
    problem?.kind === "exists"
      ? describeExistsRefusal(problem.mcpServerId, problem.existing)
      : problem?.kind === "plugin-origin"
        ? describePluginOriginRefusal({
            refusal: problem.refusal,
            message: problem.message,
            plugins: dialog.plugins,
            connections: dialog.connections,
            pluginsSettings: dialog.pluginsSettings,
          })
        : null;
  const issues = problem?.kind === "invalid" ? problem.issues : null;
  return {
    kind: "add-form",
    refusal,
    addressIssue: issues?.address ?? null,
    nameIssue: issues?.name ?? null,
    problemText: problem?.kind === "failed" ? problem.message : (issues?.other ?? null),
  };
};

/** Makes a wait step that carries the closing note of the step it is part of. */
type MakeWait = (text: string, button: "close" | "cancel-sign-in" | null) => WaitStep;

/** Describes the steps of the sign-in through the browser. */
const describeSignIn = (
  step: SignInStep,
  closingNote: string | null,
  wait: MakeWait,
): UrlServerLaterStep => {
  switch (step.kind) {
    case "starting":
      return wait("Preparing the sign-in…", "cancel-sign-in");
    case "finishing":
      return wait("Finishing the sign-in…", null);
    case "refused":
      return {
        kind: "sign-in-refused",
        message: step.message,
        cancel: { label: "Cancel" },
        startAgain: { label: "Start again" },
        closingNote,
      };
    case "waiting": {
      const listener = step.returnBy === "listener";
      return {
        kind: "sign-in-waiting",
        heading: "Finish in your browser",
        approval: `You will approve on ${step.approvalHost}.`,
        instruction: listener
          ? "Approve the sign-in in your browser. This window finishes by itself when the browser comes back."
          : "Approve the sign-in in your browser. The browser then shows an error page for an address that starts with http://127.0.0.1. Copy that address from the address bar and paste it here.",
        open: {
          label: step.opened ? "Open again" : "Open the browser",
          url: step.authorizationUrl,
        },
        openError:
          step.openError === null
            ? null
            : `The browser did not open the sign-in page. ${step.openError}`,
        cancel: { label: "Cancel" },
        paste: {
          alwaysShown: !listener || step.pasteProblem !== null,
          question:
            listener && step.opened ? "Approved, and the browser did not come back here?" : null,
          toggle: listener && step.opened ? "Paste the browser's address…" : null,
          label: "Address the browser ended on",
          submit: "Finish sign-in",
          problem: step.pasteProblem,
        },
        closingNote,
      };
    }
  }
};

/** Describes why an attempt has nothing left to follow. */
const describeEnded = (
  state: Extract<UrlServerAttemptState, { kind: "ended" }>,
  open: OpenServerAction | null,
  closingNote: string | null,
): UrlServerLaterStep => {
  switch (state.reason) {
    case "closed":
      return { kind: "closed", closingNote: null };
    case "gone":
      return {
        kind: "ended",
        headline: `${state.name ?? "This server"} was removed.`,
        body: "There is nothing more to do here.",
        open,
        close: { label: "Close" },
        closingNote,
      };
    case "moved":
      return {
        kind: "ended",
        headline: `${state.name ?? "This server"} is reached with a Connection now.`,
        body: state.message ?? "Its sign-in is the Connection's, not a token.",
        open,
        close: { label: "Close" },
        closingNote,
      };
  }
};

/** Describes the outcome of the check of the server the attempt follows. */
const describeFollowing = (
  state: Extract<UrlServerAttemptState, { kind: "following" }>,
  dialog: UrlServerDialog,
  open: OpenServerAction | null,
  closingNote: string | null,
  wait: MakeWait,
): UrlServerLaterStep => {
  const server = state.server ?? (dialog.kind === "token" ? dialog.server : null);
  const { outcome } = state;
  switch (outcome.kind) {
    case "reading":
      return wait("Reading the server…", "close");
    case "checking":
      return wait(`Asking ${readHost(server)} for its tools…`, "close");
    case "read-failed":
      return {
        kind: "read-failed",
        headline: "The server could not be read, so what the check found is not known.",
        body: `It may have succeeded. ${outcome.message}`,
        close: { label: "Close" },
        tryAgain: { label: "Try again" },
        closingNote,
      };
    case "ready":
      return {
        kind: "ready",
        name: server?.name ?? "server",
        address: server === null ? null : readAddress(server),
        summary: `ready · ${String(outcome.toolCount)} ${outcome.toolCount === 1 ? "tool" : "tools"}`,
        tools: server?.tools ?? [],
        newServerNote: outcome.newServer ? NEW_SERVER_NOTE : null,
        open,
        close: { label: "Done" },
        closingNote,
      };
    case "needs-token":
      return server === null
        ? wait("Reading the server…", "close")
        : {
            kind: "token-form",
            subject:
              dialog.kind === "add" ? { name: server.name, address: readAddress(server) } : null,
            words: describeTokenForm(
              server,
              state.problem,
              decideTokenFormEntry(state, dialog.kind === "add" ? "sign-in" : dialog.entry),
            ),
            refusedReason: describeRefusedWrite(outcome.refusedWrite, outcome.detail),
            closingNote,
          };
    case "failed":
      return {
        kind: "failed",
        headline:
          outcome.status === "unreachable"
            ? `${readHost(server)} could not be reached.`
            : `${readHost(server)} answered in a way Hercule could not use.`,
        detail: outcome.detail,
        checkError: state.check.error,
        close: { label: "Close" },
        checkNow: { label: "Check now", busy: state.check.busy },
        open,
        closingNote,
      };
    case "off":
      return {
        kind: "off",
        text: describeOff(outcome.saved),
        open,
        close: { label: "Done" },
        closingNote,
      };
  }
};

/**
 * Returns the step a dialog draws for what its attempt shows (`state`).
 * `dialog` says which dialog it is, and so where it was opened, which button
 * opened it, and what the dialog knew of the server when it opened.
 *
 * The words are the same in both apps. A sentence that names a server uses the
 * record the attempt read, else the record the dialog was opened for.
 */
export function describeUrlServerStep(
  state: UrlServerAttemptState,
  dialog: Extract<UrlServerDialog, { kind: "token" }>,
): UrlServerLaterStep;
export function describeUrlServerStep(
  state: UrlServerAttemptState,
  dialog: UrlServerDialog,
): UrlServerStep;
export function describeUrlServerStep(
  state: UrlServerAttemptState,
  dialog: UrlServerDialog,
): UrlServerStep {
  const closingNote = describeClosing(state, dialog);
  const wait: MakeWait = (text, kind) => ({
    kind: "wait",
    text,
    closingNote,
    button: kind === null ? null : { kind, label: kind === "close" ? "Close" : "Cancel" },
  });
  switch (state.kind) {
    case "form":
      return dialog.kind === "add"
        ? { ...describeAddForm(state, dialog), closingNote }
        : {
            kind: "token-form",
            subject: null,
            words: describeTokenForm(dialog.server, state.problem, dialog.entry),
            refusedReason: null,
            closingNote,
          };
    case "writing":
      return wait(
        state.write === "create" ? "Asking the server what it needs…" : "Saving the token…",
        "close",
      );
    case "signing-in":
      return describeSignIn(state.step, closingNote, wait);
    case "ended":
      return describeEnded(state, describeOpenServer(state, dialog), closingNote);
    case "following":
      return describeFollowing(state, dialog, describeOpenServer(state, dialog), closingNote, wait);
  }
}
