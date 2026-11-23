/**
 * The parts of the two dialogs that write a server added by URL (spec 17
 * §Settings, MCP servers, Adding and replacing): the Add by URL dialog, and
 * the token dialog that the page's "Replace token…" and the "Sign in…" of a
 * thread line and of the band open. Presentational: every part takes values
 * and callbacks and reads nothing. The two orchestrators (`-add-server-dialog.tsx`
 * of the route, and `token-dialog.tsx`) hold the attempt and the fields.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ADDRESS_FIELD_HINT,
  describeFailedCheck,
  describeOffOutcome,
  describeReadyTools,
  describeSignInWaiting,
  describeToolNamePreview,
  NEW_SERVER_NOTE,
  type AddFormReading,
  type FlowProblem,
  type OpenServerAction,
  type RefusalAction,
  type RefusalDescription,
  type ServerOutcome,
  type TokenFormWords,
  type UrlServerFlowState,
} from "@hercule/client-core/mcp-servers";
import type { McpServer } from "@hercule/contract";
import { ExternalIcon } from "../../../icons/external";
import { QuestionIcon } from "../../../icons/question";
import { ToolsIcon } from "../../../icons/tools";
import { GlassDialog } from "../../glass-dialog";
import { DoneMark, FormField, MarkedRow, MarkedRows, WaitLine, Warning } from "../../step";
import { TextParts } from "./server-parts";
import "../connections/connection-setup.css";
import "./url-server-dialogs.css";

/**
 * Renders the dialog around `children`: its glass, its heading and its body.
 * `onClose` is called whenever it closes. `onCloseRequest` is called when the
 * user presses Esc or the scrim, before anything closes: the caller ends what
 * the dialog runs and then closes the dialog itself, so nothing that arrives
 * between the request and the close event still reaches the dialog.
 */
export function UrlServerDialogFrame({
  dialogRef,
  heading,
  onClose,
  onCloseRequest,
  children,
}: {
  readonly dialogRef: RefObject<HTMLDialogElement | null>;
  readonly heading: string;
  readonly onClose: () => void;
  readonly onCloseRequest?: () => void;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <GlassDialog
      dialogRef={dialogRef}
      className="setup-dialog url-dialog"
      label={heading}
      onClose={onClose}
      {...(onCloseRequest === undefined ? {} : { onCloseRequest })}
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
        <FormField label="Address" hint={ADDRESS_FIELD_HINT} error={issues?.address ?? null}>
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
 * Renders the sign-in form of a server added by URL, opened as `words.method`
 * says: the browser choice (`words.browser`), with the token field behind
 * "Paste a token instead", or the token field. The token part is the sentence
 * `words.intro`, the masked Token field with `words.note` under it, and Save
 * token. `refusedReason` is the controller's reason when the token this
 * dialog saved was refused, and the field shows `words.problemText` first.
 * Every wording comes from `describeTokenForm`, so Add, "Replace token…" and
 * every "Sign in…" say the same.
 *
 * The field owns its draft. `onSubmit` hands the token over, and the form is
 * gone while the write and the check run, so a refused check opens an empty
 * field and no copy of the token stays in the dialog.
 */
export function TokenForm({
  words,
  refusedReason,
  onSubmit,
  onSignIn,
  onCancel,
}: {
  readonly words: TokenFormWords;
  /** The controller's reason for refusing the token this dialog saved, or `null`. */
  readonly refusedReason: string | null;
  readonly onSubmit: (token: string) => void;
  /** Starts the sign-in through the browser. */
  readonly onSignIn: () => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const [token, setToken] = useState("");
  // The user's press of "Paste a token instead" adds to what the words say the form opens with,
  // so a record that changes while the form is open can still move an untouched form.
  const [choseToken, setChoseToken] = useState(false);
  const showsToken = choseToken || words.method === "token";
  const { browser } = words;
  if (browser !== null && !showsToken) {
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
              setChoseToken(true);
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
        if (token !== "") onSubmit(token);
      }}
    >
      <p className="setup-lead">{words.intro}</p>
      <FormField label="Token" hint={words.note} error={words.problemText ?? refusedReason}>
        <input
          type="password"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(event) => {
            setToken(event.target.value);
          }}
        />
      </FormField>
      {words.offNote !== null && <p className="setup-lead url-note">{words.offNote}</p>}
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

/** Renders the tools a server offered: each name in the code font, with its description. */
function ToolList({ tools }: { readonly tools: McpServer["tools"] }): JSX.Element | null {
  if (tools.length === 0) return null;
  return (
    <div className="url-tools">
      {tools.map((tool) => (
        <div key={tool.name} className="mcp-tool">
          <code>{tool.name}</code>
          <span>{tool.description}</span>
        </div>
      ))}
    </div>
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
  server,
  outcome,
  openAction,
  closingNote,
  checkBusy,
  checkError,
  actions,
}: {
  readonly server: McpServer | null;
  readonly outcome: Exclude<ServerOutcome, { kind: "needs-token" }>;
  /** The "Open <name>" button, or `null` when the outcome leads nowhere else (see `describeOpenServerAction`). */
  readonly openAction: OpenServerAction | null;
  /** What closing the dialog now does, or `null` (see `describeClosing`). */
  readonly closingNote: string | null;
  readonly checkBusy: boolean;
  readonly checkError: string | null;
  readonly actions: OutcomeActions;
}): JSX.Element {
  const openButton =
    openAction === null ? null : (
      <button
        type="button"
        className="btn btn--accent"
        autoFocus
        onClick={() => {
          actions.onOpenServer(openAction.mcpServerId);
        }}
      >
        {openAction.label}
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
            <>
              <ServerCard
                server={server}
                end={<DoneMark>{describeReadyTools(outcome.toolCount)}</DoneMark>}
              />
              <ToolList tools={server.tools} />
            </>
          )}
          {outcome.newServer && <p className="setup-lead url-note">{NEW_SERVER_NOTE}</p>}
          <div className="setup-acts">
            {openButton === null ? (
              <button type="button" className="btn btn--accent" autoFocus onClick={actions.onClose}>
                Done
              </button>
            ) : (
              <>
                {closeButton("Done")}
                {openButton}
              </>
            )}
          </div>
        </>
      );
    case "failed": {
      const failed = describeFailedCheck({
        status: outcome.status,
        detail: outcome.detail,
        server,
      });
      return (
        <>
          <Warning icon={<QuestionIcon size={14} />}>
            <b>{failed.headline}</b> {failed.detail}
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
    }
    case "off":
      return (
        <>
          <p className="setup-lead">{describeOffOutcome(outcome.saved)}</p>
          <div className="setup-acts">
            {openButton === null ? (
              <button type="button" className="btn btn--accent" autoFocus onClick={actions.onClose}>
                Done
              </button>
            ) : (
              <>
                {closeButton("Done")}
                {openButton}
              </>
            )}
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
  openAction,
  onClose,
  onOpenServer,
}: {
  readonly state: Extract<UrlServerFlowState, { kind: "ended" }>;
  /** The "Open <name>" button of a server that moved onto a Connection, or `null`. */
  readonly openAction: OpenServerAction | null;
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
        {openAction !== null && (
          <button
            type="button"
            className="btn btn--accent"
            onClick={() => {
              onOpenServer(openAction.mcpServerId);
            }}
          >
            {openAction.label}
          </button>
        )}
      </div>
    </>
  );
}

/** What `FlowBody` needs to run the token form and the outcome's buttons. */
export interface FlowBodyActions extends OutcomeActions {
  /** Writes the token the form handed over. */
  readonly onSaveToken: (token: string) => void;
  /** Starts the sign-in through the browser, or starts it again after a refusal. */
  readonly onStartSignIn: () => void;
  /** Ends the sign-in and returns to the form. */
  readonly onCancelSignIn: () => void;
  /** Opens the sign-in page in the browser. */
  readonly onOpenSignInPage: () => void;
  /** Finishes the sign-in with the address the user pasted. */
  readonly onFinishSignIn: (pasted: string) => void;
}

/**
 * Renders the steps of a sign-in through the browser, from the attempt's
 * `signing-in` state:
 *
 * - `starting` and `finishing`: a wait;
 * - `waiting`: a card that says who asks for the approval, with Open again
 *   and Cancel, and under it the way back when the browser does not return
 *   here: "Paste the browser's address…". When the app could not start its
 *   listener, the paste is the only way back and its field is shown at once;
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

/**
 * Renders the waiting step of a sign-in as a card: the heading, who asks for
 * the approval, what to do in the browser, Open again and Cancel, and the
 * paste. The step opens the browser itself, once, after this card has drawn
 * who asks for the approval, so the user reads the host before the browser
 * takes the focus.
 */
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
    openedByApp: step.opened,
  });
  const pasteShown = step.returnBy === "paste" || showsPaste || step.pasteProblem !== null;
  // The browser takes the focus when it opens, so it opens only once this card has been presented:
  // after the next animation frame, and in the task after it. An effect runs when the commit ends,
  // which can be before the frame that shows the card, so it only schedules the open. The cleanup
  // cancels it (Strict Mode's first run, a step that goes away, the user pressing Open again).
  const openRef = useRef(actions.onOpenSignInPage);
  useLayoutEffect(() => {
    openRef.current = actions.onOpenSignInPage;
  });
  const pendingOpen = !step.opened;
  useEffect(() => {
    if (!pendingOpen) return;
    let task: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      task = setTimeout(() => {
        openRef.current();
      }, 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(task);
    };
  }, [pendingOpen]);
  return (
    <div className="url-waiting">
      <MarkedRows>
        <MarkedRow
          mark={<ToolsIcon size={18} />}
          name={words.heading}
          detail={words.approval}
          end={
            <span className="setup-row-acts">
              <button type="button" className="btn btn--sm" onClick={actions.onOpenSignInPage}>
                <ExternalIcon size={14} />
                {words.openLabel}
              </button>
              <button
                type="button"
                className="btn btn--sm btn--quiet"
                onClick={actions.onCancelSignIn}
              >
                Cancel
              </button>
            </span>
          }
        >
          <WaitLine text={words.instruction} />
          {step.openError !== null && (
            <p className="fl-err" role="alert">
              {`The browser did not open the sign-in page: ${step.openError}`}
            </p>
          )}
          {pasteShown && (
            <form
              className="url-paste"
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
        </MarkedRow>
      </MarkedRows>
      {words.pasteQuestion !== null && !pasteShown && (
        <p className="url-stuck">
          {words.pasteQuestion}
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              setShowsPaste(true);
            }}
          >
            {words.pasteToggle}
          </button>
        </p>
      )}
      {closingNote !== null && <p className="url-note">{closingNote}</p>}
    </div>
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
 * `tokenWords` are the words of the token form, from `describeTokenForm`, and
 * `openAction` is the dialog's "Open <name>" button, from
 * `describeOpenServerAction`.
 */
export function FlowBody({
  state,
  tokenWords,
  openAction,
  closingNote,
  checkBusy,
  checkError,
  actions,
}: {
  readonly state: Exclude<UrlServerFlowState, { kind: "form" }>;
  /** The words of the token form for the followed server, or `null` while it is not read. */
  readonly tokenWords: TokenFormWords | null;
  readonly openAction: OpenServerAction | null;
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
      // A closed attempt is the dialog going away: it has nothing left to say.
      return state.reason === "closed" ? (
        <></>
      ) : (
        <EndedView
          state={state}
          openAction={openAction}
          onClose={actions.onClose}
          onOpenServer={actions.onOpenServer}
        />
      );
    case "following":
      if (state.outcome.kind === "needs-token") {
        return tokenWords === null ? (
          <Wait text="Reading the server…" note={closingNote} />
        ) : (
          <TokenForm
            words={tokenWords}
            refusedReason={
              state.outcome.refusedAgain
                ? (state.outcome.detail ?? "The server refused this token.")
                : null
            }
            onSubmit={actions.onSaveToken}
            onSignIn={actions.onStartSignIn}
            onCancel={actions.onClose}
          />
        );
      }
      return (
        <OutcomeView
          server={state.server}
          outcome={state.outcome}
          openAction={openAction}
          closingNote={closingNote}
          checkBusy={checkBusy}
          checkError={checkError}
          actions={actions}
        />
      );
  }
}
