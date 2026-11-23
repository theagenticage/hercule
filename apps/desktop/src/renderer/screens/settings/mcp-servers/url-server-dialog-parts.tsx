/**
 * The parts of the two dialogs that write a server added by URL (spec 17
 * §Settings, MCP servers, Adding and replacing): the Add by URL dialog, and
 * the token dialog that the page's "Replace token…" and the "Sign in…" of a
 * thread line and of the band open. Presentational: every part takes values
 * and callbacks and reads nothing. The two orchestrators (`-add-server-dialog.tsx`
 * of the route, and `token-dialog.tsx`) hold the attempt and the fields.
 */
import { useState, type FormEvent, type JSX, type ReactNode, type RefObject } from "react";
import {
  describeOffOutcome,
  describeReadyTools,
  describeSignInWaiting,
  describeToolNamePreview,
  NEW_SERVER_NOTE,
  type AddFormReading,
  type FlowProblem,
  type RefusalAction,
  type RefusalDescription,
  type ServerOutcome,
  type TokenFormWords,
  type UrlServerFlowState,
} from "@hercule/client-core/mcp-servers";
import type { McpServer } from "@hercule/contract";
import { QuestionIcon } from "../../../icons/question";
import { ToolsIcon } from "../../../icons/tools";
import { GlassDialog } from "../../glass-dialog";
import { DoneMark, FormField, MarkedRow, MarkedRows, WaitLine, Warning } from "../../step";
import { TextParts } from "./server-parts";
import "../connections/connection-setup.css";
import "./url-server-dialogs.css";

/** Renders the dialog around `children`: its glass, its heading and its body. `onClose` is called whenever it closes. */
export function UrlServerDialogFrame({
  dialogRef,
  heading,
  onClose,
  children,
}: {
  readonly dialogRef: RefObject<HTMLDialogElement | null>;
  readonly heading: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <GlassDialog
      dialogRef={dialogRef}
      className="setup-dialog url-dialog"
      label={heading}
      onClose={onClose}
    >
      <div className="pop-h">
        <b>{heading}</b>
      </div>
      <div className="pop-sec setup-dialog-body">{children}</div>
    </GlassDialog>
  );
}

/** Returns what the attempt's problem says in the form, or `null` when it holds none that has no field of its own. */
const describeProblemText = (problem: FlowProblem | null): string | null => {
  switch (problem?.kind) {
    case undefined:
    case "exists":
      return null;
    case "plugin-origin":
      return problem.message;
    case "invalid":
      return problem.issues.other;
    case "failed":
      return problem.message;
    case "sign-in-unsupported":
      // The token form says it above its field.
      return null;
  }
};

/**
 * Renders the first step of Add by URL: the Address and the Name, and, when
 * the controller refused the address, the refusal between them with its
 * button.
 *
 * - `reading` is `readAddForm` for the two fields. The Name shows the name
 *   the user typed, else the suggestion, and the line under it says how
 *   agents see the tools.
 * - `refusal` is what the controller's duplicate refusal says (see
 *   `describeExistsRefusal`), `onRefusalAction` runs its button.
 * - `problem` holds the other reasons the last "Check server" failed.
 */
export function AddForm({
  address,
  typedName,
  reading,
  problem,
  refusal,
  onAddressChange,
  onNameChange,
  onSubmit,
  onRefusalAction,
  onCancel,
}: {
  readonly address: string;
  readonly typedName: string | null;
  readonly reading: AddFormReading;
  readonly problem: FlowProblem | null;
  readonly refusal: RefusalDescription | null;
  readonly onAddressChange: (address: string) => void;
  readonly onNameChange: (name: string) => void;
  readonly onSubmit: () => void;
  readonly onRefusalAction: (action: RefusalAction) => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const issues = problem?.kind === "invalid" ? problem.issues : null;
  const otherProblem = describeProblemText(problem);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (reading.canSubmit) onSubmit();
  };
  return (
    <form onSubmit={submit}>
      <div className="url-form">
        <FormField
          label="Address"
          hint="A remote MCP server, reached over HTTPS. The controller calls it, so it must be reachable from there."
          error={issues?.address ?? null}
        >
          <input
            autoFocus
            spellCheck={false}
            placeholder="https://mcp.example.com/mcp"
            value={address}
            onChange={(event) => {
              onAddressChange(event.target.value);
            }}
          />
        </FormField>
        {refusal !== null && (
          <Warning icon={<ToolsIcon size={14} />}>
            <TextParts parts={refusal.sentence} />
            {refusal.action !== null && (
              <>
                <br />
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => {
                    onRefusalAction(refusal.action!);
                  }}
                >
                  {refusal.action.label}
                </button>
              </>
            )}
          </Warning>
        )}
        <FormField
          label="Name"
          hint={<TextParts parts={describeToolNamePreview(reading.name)} />}
          error={reading.nameIssue ?? issues?.name ?? null}
        >
          <input
            className="mono"
            spellCheck={false}
            placeholder={reading.name}
            value={typedName ?? reading.name}
            onChange={(event) => {
              onNameChange(event.target.value);
            }}
          />
        </FormField>
      </div>
      {otherProblem !== null && (
        <p className="fl-err setup-error" role="alert">
          {otherProblem}
        </p>
      )}
      <div className="setup-acts">
        <button type="button" className="btn btn--quiet" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn--accent" disabled={!reading.canSubmit}>
          Check server
        </button>
      </div>
    </form>
  );
}

/**
 * Renders the sign-in form of a server added by URL. A server that signs in
 * through the browser gets that first (`words.browser`), with the pasted token
 * behind "Paste a token instead", unless the controller said the browser does
 * not work for it. The token part is the sentence `words.intro`, the masked
 * Token field with `words.note` under it, and Save token. `problem` is why the
 * last write did not go through, and `refusedReason` is the controller's reason
 * when the token this dialog saved was refused. Every wording comes from
 * `describeTokenForm`, so Add, "Replace token…" and every "Sign in…" say the
 * same.
 */
export function TokenForm({
  words,
  token,
  problem,
  refusedReason,
  onTokenChange,
  onSubmit,
  onSignIn,
  onCancel,
}: {
  readonly words: TokenFormWords;
  readonly token: string;
  readonly problem: FlowProblem | null;
  /** The controller's reason for refusing the token this dialog saved, or `null`. */
  readonly refusedReason: string | null;
  readonly onTokenChange: (token: string) => void;
  readonly onSubmit: () => void;
  /** Starts the sign-in through the browser. */
  readonly onSignIn: () => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const issues = problem?.kind === "invalid" ? problem.issues : null;
  const fieldError =
    issues?.token ?? (problem?.kind === "failed" ? problem.message : null) ?? refusedReason;
  // The browser is offered unless the controller said it does not work for this server.
  const browser = problem?.kind === "sign-in-unsupported" ? null : words.browser;
  const [pasting, setPasting] = useState(browser === null || problem !== null);
  if (browser !== null && !pasting) {
    return (
      <>
        <p className="setup-lead">{browser.intro}</p>
        {refusedReason !== null && (
          <p className="fl-err setup-error" role="alert">
            {refusedReason}
          </p>
        )}
        {words.offNote !== null && <p className="setup-lead url-note">{words.offNote}</p>}
        <div className="setup-acts">
          <button type="button" className="btn btn--quiet" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setPasting(true);
            }}
          >
            {browser.pasteToggle}
          </button>
          <button type="button" className="btn btn--accent" autoFocus onClick={onSignIn}>
            {browser.label}
          </button>
        </div>
      </>
    );
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (token !== "") onSubmit();
      }}
    >
      {problem?.kind === "sign-in-unsupported" && (
        <p className="fl-err setup-error" role="alert">
          {problem.message}
        </p>
      )}
      <p className="setup-lead">{words.intro}</p>
      <FormField label="Token" hint={words.note} error={fieldError}>
        <input
          type="password"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(event) => {
            onTokenChange(event.target.value);
          }}
        />
      </FormField>
      {words.offNote !== null && <p className="setup-lead url-note">{words.offNote}</p>}
      {issues?.other != null && (
        <p className="fl-err setup-error" role="alert">
          {issues.other}
        </p>
      )}
      <div className="setup-acts">
        <button type="button" className="btn btn--quiet" onClick={onCancel}>
          Cancel
        </button>
        {browser !== null && (
          <button type="button" className="btn" onClick={onSignIn}>
            {browser.label}
          </button>
        )}
        <button
          type="submit"
          className={browser === null ? "btn btn--accent" : "btn"}
          disabled={token === ""}
        >
          {words.submitLabel}
        </button>
      </div>
    </form>
  );
}

/** Returns the host of the server's address, for a line that says whom the controller is asking. */
const readHost = (server: McpServer | null): string =>
  server?.source.kind === "url" && URL.canParse(server.source.url)
    ? new URL(server.source.url).host
    : "the server";

/** The actions of a finished or failed check. */
interface OutcomeActions {
  /** Closes the dialog. */
  readonly onClose: () => void;
  /** Closes the dialog and opens the server's page. */
  readonly onOpenServer: (mcpServerId: string) => void;
  /** Starts a check again. */
  readonly onCheckNow: () => void;
  /** Reads the followed server again, after its record could not be read. */
  readonly onRetryRead: () => void;
}

/** Renders the server `server` as the done step does: its mark, name and address, and what the check found at the end. */
function ServerCard({
  server,
  end,
}: {
  readonly server: McpServer;
  readonly end: ReactNode;
}): JSX.Element {
  return (
    <MarkedRows>
      <MarkedRow
        mark={<ToolsIcon size={18} />}
        name={server.name}
        detail={server.source.kind === "url" ? server.source.url : ""}
        end={end}
      />
    </MarkedRows>
  );
}

/**
 * Renders what the attempt shows once the write was acknowledged and the
 * server is followed: a wait while it is read or checked, the done step, a
 * failed check or a record that could not be read, and a server that is off.
 * `server` is the record the outcome was decided from.
 *
 * The check's failure and the failure to read the record are said apart: the
 * second does not mean the server is broken.
 */
export function OutcomeView({
  mcpServerId,
  server,
  outcome,
  closingNote,
  checkBusy,
  checkError,
  actions,
}: {
  readonly mcpServerId: string;
  readonly server: McpServer | null;
  readonly outcome: Exclude<ServerOutcome, { kind: "needs-token" }>;
  /** What closing the dialog now does, or `null` (see `describeClosing`). */
  readonly closingNote: string | null;
  readonly checkBusy: boolean;
  readonly checkError: string | null;
  readonly actions: OutcomeActions;
}): JSX.Element {
  const name = server?.name ?? "server";
  const openButton = (
    <button
      type="button"
      className="btn btn--accent"
      autoFocus
      onClick={() => {
        actions.onOpenServer(mcpServerId);
      }}
    >
      {`Open ${name}`}
    </button>
  );
  const closeButton = (label: string): JSX.Element => (
    <button type="button" className="btn btn--quiet" onClick={actions.onClose}>
      {label}
    </button>
  );
  switch (outcome.kind) {
    case "reading":
      return <Wait text="Reading the server…" note={closingNote} />;
    case "checking":
      return <Wait text={`Asking ${readHost(server)} for its tools.`} note={closingNote} />;
    case "read-failed":
      return (
        <>
          <Warning icon={<QuestionIcon size={14} />}>
            <b>The server's record could not be read.</b> The check may have worked.{" "}
            {outcome.message}
          </Warning>
          <div className="setup-acts">
            {closeButton("Close")}
            <button type="button" className="btn btn--accent" onClick={actions.onRetryRead}>
              Try again
            </button>
          </div>
        </>
      );
    case "ready":
      return (
        <>
          {server !== null && (
            <ServerCard
              server={server}
              end={<DoneMark>{describeReadyTools(outcome.toolCount)}</DoneMark>}
            />
          )}
          {outcome.newServer ? (
            <>
              <p className="setup-lead url-note">{NEW_SERVER_NOTE}</p>
              <div className="setup-acts">
                {closeButton("Done")}
                {openButton}
              </div>
            </>
          ) : (
            <div className="setup-acts">
              <button type="button" className="btn btn--accent" autoFocus onClick={actions.onClose}>
                Done
              </button>
            </div>
          )}
        </>
      );
    case "failed":
      return (
        <>
          <Warning icon={<QuestionIcon size={14} />}>
            <b>
              {outcome.status === "unreachable"
                ? `${readHost(server)} could not be reached.`
                : `${readHost(server)} answered in a way Hercule could not use.`}
            </b>{" "}
            {outcome.detail}
          </Warning>
          {checkError !== null && (
            <p className="fl-err setup-error" role="alert">
              {checkError}
            </p>
          )}
          <div className="setup-acts">
            {closeButton("Close")}
            <button
              type="button"
              className="btn"
              aria-disabled={checkBusy}
              onClick={() => {
                if (!checkBusy) actions.onCheckNow();
              }}
            >
              Check now
            </button>
            {openButton}
          </div>
        </>
      );
    case "off":
      return (
        <>
          <p className="setup-lead">{describeOffOutcome(outcome.saved)}</p>
          <div className="setup-acts">
            {closeButton("Done")}
            {openButton}
          </div>
        </>
      );
  }
}

/** Renders a wait line and, under it, what closing the dialog now does. */
function Wait({
  text,
  note,
}: {
  readonly text: string;
  readonly note: string | null;
}): JSX.Element {
  return (
    <div className="url-wait">
      <WaitLine text={text} />
      {note !== null && <p className="url-note">{note}</p>}
    </div>
  );
}

/** Renders a wait while a write runs, with what closing the dialog now does. */
export function WritingView({
  state,
  closingNote,
}: {
  readonly state: Extract<UrlServerFlowState, { kind: "writing" }>;
  readonly closingNote: string | null;
}): JSX.Element {
  return (
    <Wait
      text={state.write === "create" ? "Checking the server…" : "Saving the token…"}
      note={closingNote}
    />
  );
}

/**
 * Renders why the attempt has nothing left to follow: the server was
 * removed, or it is reached with a plugin's Connection now. `message` is the
 * controller's own words when it refused a write for that reason.
 */
export function EndedView({
  state,
  onClose,
  onOpenServer,
}: {
  readonly state: Extract<UrlServerFlowState, { kind: "ended" }>;
  readonly onClose: () => void;
  readonly onOpenServer: (mcpServerId: string) => void;
}): JSX.Element {
  const name = state.name ?? "This server";
  return (
    <>
      <Warning icon={<QuestionIcon size={14} />}>
        {state.reason === "gone" ? (
          <>
            <b>{`${name} was removed.`}</b> There is nothing left to sign in to.
          </>
        ) : (
          <>
            <b>{`${name} is reached with a Connection now.`}</b>{" "}
            {state.message ?? "Its sign-in is the Connection's, not a token."}
          </>
        )}
      </Warning>
      <div className="setup-acts">
        <button type="button" className="btn btn--quiet" onClick={onClose}>
          Close
        </button>
        {state.reason === "moved" && state.mcpServerId !== null && (
          <button
            type="button"
            className="btn btn--accent"
            onClick={() => {
              onOpenServer(state.mcpServerId!);
            }}
          >
            {state.name === null ? "Open server" : `Open ${state.name}`}
          </button>
        )}
      </div>
    </>
  );
}

/** What `FlowBody` needs to run the token form and the outcome's buttons. */
export interface FlowBodyActions extends OutcomeActions {
  readonly onTokenChange: (token: string) => void;
  readonly onSaveToken: () => void;
  /** Starts the sign-in through the browser, or starts it again after a refusal. */
  readonly onStartSignIn: () => void;
  /** Ends the sign-in and returns to the form. */
  readonly onCancelSignIn: () => void;
  /** Opens the sign-in page in the browser again. */
  readonly onOpenSignInPage: () => void;
  /** Finishes the sign-in with the address the user pasted. */
  readonly onFinishSignIn: (pasted: string) => void;
}

/**
 * Renders the steps of a sign-in through the browser, from the attempt's
 * `signing-in` state:
 *
 * - `starting` and `finishing`: a wait;
 * - `waiting`: who asks for the approval, Open again and Cancel, and the way
 *   back when the browser does not return here: "Paste the browser's
 *   address…". When the app could not start its listener, the paste is the
 *   only way back and its field is shown at once;
 * - `refused`: why the sign-in ended, with Start again.
 */
export function SignInView({
  state,
  closingNote,
  actions,
}: {
  readonly state: Extract<UrlServerFlowState, { kind: "signing-in" }>;
  readonly closingNote: string | null;
  readonly actions: FlowBodyActions;
}): JSX.Element {
  const { step } = state;
  switch (step.kind) {
    case "starting":
      return (
        <>
          <Wait text="Preparing the sign-in…" note={closingNote} />
          <div className="setup-acts">
            <button type="button" className="btn btn--quiet" onClick={actions.onCancelSignIn}>
              Cancel
            </button>
          </div>
        </>
      );
    case "finishing":
      return <Wait text="Finishing the sign-in…" note={closingNote} />;
    case "refused":
      return (
        <>
          <Warning icon={<QuestionIcon size={14} />}>{step.message}</Warning>
          <div className="setup-acts">
            <button type="button" className="btn btn--quiet" onClick={actions.onCancelSignIn}>
              Cancel
            </button>
            <button type="button" className="btn btn--accent" onClick={actions.onStartSignIn}>
              Start again
            </button>
          </div>
        </>
      );
    case "waiting":
      return <WaitingView step={step} closingNote={closingNote} actions={actions} />;
  }
}

/** Renders the waiting step of a sign-in: the approval host, Open again, Cancel and the paste. */
function WaitingView({
  step,
  closingNote,
  actions,
}: {
  readonly step: Extract<
    Extract<UrlServerFlowState, { kind: "signing-in" }>["step"],
    { kind: "waiting" }
  >;
  readonly closingNote: string | null;
  readonly actions: FlowBodyActions;
}): JSX.Element {
  const [pasted, setPasted] = useState("");
  const [showsPaste, setShowsPaste] = useState(false);
  const words = describeSignInWaiting({
    approvalHost: step.approvalHost,
    returnBy: step.returnBy,
    openedByApp: true,
  });
  const pasteShown = step.returnBy === "paste" || showsPaste || step.pasteProblem !== null;
  return (
    <>
      <p className="setup-lead">
        <b>{words.heading}</b>
      </p>
      <p className="setup-lead">{words.approval}</p>
      <p className="setup-lead url-note">{words.instruction}</p>
      {step.openError !== null && (
        <p className="fl-err setup-error" role="alert">
          {`The browser did not open the sign-in page: ${step.openError}`}
        </p>
      )}
      {words.pasteQuestion !== null && (
        <p className="setup-lead url-note">
          {words.pasteQuestion}{" "}
          {!pasteShown && (
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              onClick={() => {
                setShowsPaste(true);
              }}
            >
              {words.pasteToggle}
            </button>
          )}
        </p>
      )}
      {pasteShown && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (pasted.trim() !== "") actions.onFinishSignIn(pasted);
          }}
        >
          <FormField label={words.pasteLabel} error={step.pasteProblem}>
            <input
              autoFocus={step.returnBy === "listener"}
              spellCheck={false}
              autoComplete="off"
              placeholder="http://127.0.0.1:…/callback?code=…"
              value={pasted}
              onChange={(event) => {
                setPasted(event.target.value);
              }}
            />
          </FormField>
          <div className="setup-acts">
            <button type="submit" className="btn btn--accent" disabled={pasted.trim() === ""}>
              {words.pasteSubmit}
            </button>
          </div>
        </form>
      )}
      {closingNote !== null && <p className="url-note">{closingNote}</p>}
      <div className="setup-acts">
        <button type="button" className="btn btn--quiet" onClick={actions.onCancelSignIn}>
          Cancel
        </button>
        <button type="button" className="btn" onClick={actions.onOpenSignInPage}>
          {words.openLabel}
        </button>
      </div>
    </>
  );
}

/**
 * Renders everything after the first step of both dialogs, from the attempt's
 * `state` (any state but `form`, which each dialog draws itself):
 *
 * - `writing`: a wait;
 * - `signing-in`: the steps of the sign-in through the browser;
 * - `following`: the token form again when the server wants a token (the
 *   controller refused the one saved, or it needs one), else the outcome of
 *   the check;
 * - `ended`: why there is nothing left to follow.
 *
 * `server` is the record the words are decided from. `token` is the text of
 * the token field, which the dialog keeps.
 */
export function FlowBody({
  state,
  tokenWords,
  token,
  closingNote,
  checkBusy,
  checkError,
  actions,
}: {
  readonly state: Exclude<UrlServerFlowState, { kind: "form" }>;
  /** The words of the token form for the followed server, or `null` while it is not read. */
  readonly tokenWords: TokenFormWords | null;
  readonly token: string;
  readonly closingNote: string | null;
  readonly checkBusy: boolean;
  readonly checkError: string | null;
  readonly actions: FlowBodyActions;
}): JSX.Element {
  switch (state.kind) {
    case "writing":
      return <WritingView state={state} closingNote={closingNote} />;
    case "signing-in":
      return <SignInView state={state} closingNote={closingNote} actions={actions} />;
    case "ended":
      return (
        <EndedView state={state} onClose={actions.onClose} onOpenServer={actions.onOpenServer} />
      );
    case "following":
      if (state.outcome.kind === "needs-token") {
        return tokenWords === null ? (
          <Wait text="Reading the server…" note={closingNote} />
        ) : (
          <TokenForm
            words={tokenWords}
            token={token}
            problem={state.problem}
            refusedReason={
              state.outcome.refusedAgain
                ? (state.outcome.detail ?? "The server refused this token.")
                : null
            }
            onTokenChange={actions.onTokenChange}
            onSubmit={actions.onSaveToken}
            onSignIn={actions.onStartSignIn}
            onCancel={actions.onClose}
          />
        );
      }
      return (
        <OutcomeView
          mcpServerId={state.mcpServerId}
          server={state.server}
          outcome={state.outcome}
          closingNote={closingNote}
          checkBusy={checkBusy}
          checkError={checkError}
          actions={actions}
        />
      );
  }
}
