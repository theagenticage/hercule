/**
 * The parts of the two dialogs that write a server added by URL (spec 17
 * §Settings, MCP servers, Adding and replacing): the Add by URL dialog, and
 * the token dialog that the page's "Replace token…" and the "Sign in…" of a
 * thread line and of the band open. Presentational: every part draws a step
 * (`describeUrlServerStep`), which holds the words and the actions, and calls
 * the attempt for the user's presses. The two orchestrators
 * (`-add-server-dialog.tsx` of the route, and `token-dialog.tsx`) hold the
 * attempt and the fields.
 */
import {
  useEffect,
  useState,
  type FormEvent,
  type JSX,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ADDRESS_FIELD_HINT,
  describeToolNamePreview,
  type AddFormReading,
  type OpenServerAction,
  type RefusalAction,
  type UrlServerAttempt,
  type UrlServerLaterStep,
  type UrlServerStep,
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
  // The dialog opens in its own effect, which runs before this one, and a closed dialog cannot
  // take the focus. So a button that asks for the first focus (`data-initial-focus`), such as the
  // browser choice's primary, gets it here, after the dialog is open. Otherwise the browser
  // focuses the first control, which is Cancel or a quiet choice.
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
  }, [dialogRef]);
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

/**
 * Renders the first step of Add by URL: the Address and the Name, and, when
 * the controller refused the address, the refusal between them with its
 * button.
 *
 * - `reading` is `readAddForm` for the two fields. The Name shows the name
 *   the user typed, else the suggestion, and the line under it says how
 *   agents see the tools.
 * - `step` holds the refusal and the reasons the last "Check server" left.
 *   `onRefusalAction` runs the refusal's button.
 */
export function AddForm({
  step,
  address,
  typedName,
  reading,
  onAddressChange,
  onNameChange,
  onSubmit,
  onRefusalAction,
  onCancel,
}: {
  readonly step: Extract<UrlServerStep, { kind: "add-form" }>;
  readonly address: string;
  readonly typedName: string | null;
  readonly reading: AddFormReading;
  readonly onAddressChange: (address: string) => void;
  readonly onNameChange: (name: string) => void;
  readonly onSubmit: () => void;
  readonly onRefusalAction: (action: RefusalAction) => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const { refusal } = step;
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (reading.canSubmit) onSubmit();
  };
  return (
    <form onSubmit={submit}>
      <div className="url-form">
        <FormField label="Address" hint={ADDRESS_FIELD_HINT} error={step.addressIssue}>
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
          error={reading.nameIssue ?? step.nameIssue}
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
      {step.problemText !== null && (
        <p className="fl-err setup-error" role="alert">
          {step.problemText}
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
 * Renders the sign-in form of a server added by URL, opened as the step's
 * `words.method` says: the browser choice (`words.browser`), with the token
 * field behind "Paste a token instead", a link under the sentence, or the token
 * field. The token part is
 * the sentence `words.intro`, the masked Token field with `words.note` under
 * it, and Save token. `refusedReason` is the controller's reason when the
 * token or the sign-in this dialog wrote was refused, and the field shows
 * `words.problemText` first. In Add, `subject` names the server and its
 * address above the form, because the dialog's title does not.
 *
 * The field owns its draft. `onSubmit` hands the token over, and the form is
 * gone while the write and the check run, so a refused check opens an empty
 * field and no copy of the token stays in the dialog.
 */
function TokenForm({
  step,
  onSubmit,
  onSignIn,
  onCancel,
}: {
  readonly step: Extract<UrlServerStep, { kind: "token-form" }>;
  readonly onSubmit: (token: string) => void;
  /** Starts the sign-in through the browser. */
  readonly onSignIn: () => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const { words, refusedReason, closingNote, subject } = step;
  const [token, setToken] = useState("");
  // The user's press of "Paste a token instead" adds to what the words say the form opens with,
  // so a record that changes while the form is open can still move an untouched form.
  const [choseToken, setChoseToken] = useState(false);
  const showsToken = choseToken || words.method === "token";
  const { browser } = words;
  const subjectCard =
    subject === null ? null : (
      <div className="url-subject">
        <ServerCard name={subject.name} address={subject.address} end={null} />
      </div>
    );
  if (browser !== null && !showsToken) {
    return (
      <>
        {subjectCard}
        <p className="setup-lead">{browser.intro}</p>
        <p className="setup-lead url-token-choice">
          <button
            type="button"
            className="link"
            onClick={() => {
              setChoseToken(true);
            }}
          >
            {browser.pasteToggle}
          </button>
        </p>
        {refusedReason !== null && (
          <p className="fl-err setup-error" role="alert">
            {refusedReason}
          </p>
        )}
        {words.offNote !== null && <p className="setup-lead url-note">{words.offNote}</p>}
        {closingNote !== null && <p className="url-note">{closingNote}</p>}
        <div className="setup-acts">
          <button type="button" className="btn btn--quiet" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--accent"
            autoFocus
            data-initial-focus=""
            onClick={onSignIn}
          >
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
      {subjectCard}
      <p className="setup-lead">{words.intro}</p>
      {refusedReason !== null && (
        <p className="fl-err setup-error" role="alert">
          {refusedReason}
        </p>
      )}
      <FormField label="Token" hint={words.note} error={words.problemText}>
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
      {closingNote !== null && <p className="url-note">{closingNote}</p>}
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

/** Renders a server as the done step does: its mark, name and address, and what the check found at the end. */
function ServerCard({
  name,
  address,
  end,
}: {
  readonly name: string;
  readonly address: string;
  readonly end: ReactNode;
}): JSX.Element {
  return (
    <MarkedRows>
      <MarkedRow mark={<ToolsIcon size={18} />} name={name} detail={address} end={end} />
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

/** Renders a line that waits, and under it what closing the dialog now does. */
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

/**
 * Renders a step after the first form of either dialog, from what
 * `describeUrlServerStep` returned: the token form, a wait, the steps of the
 * sign-in through the browser, the outcome of the check, and why an attempt
 * has nothing left to follow. `attempt` takes the user's presses. `onClose`
 * ends the dialog, and `onOpenServer` closes it and opens a server's page.
 * The check's failure and the failure to read the record are said apart: the
 * second does not mean the server is broken.
 */
export function StepView({
  step,
  attempt,
  onClose,
  onOpenServer,
}: {
  readonly step: UrlServerLaterStep;
  readonly attempt: UrlServerAttempt;
  readonly onClose: () => void;
  readonly onOpenServer: (mcpServerId: string) => void;
}): JSX.Element {
  const closeButton = (label: string): JSX.Element => (
    <button type="button" className="btn btn--quiet" onClick={onClose}>
      {label}
    </button>
  );
  const openButton = (action: OpenServerAction | null, autoFocus: boolean): JSX.Element | null =>
    action === null ? null : (
      <button
        type="button"
        className="btn btn--accent"
        autoFocus={autoFocus}
        onClick={() => {
          onOpenServer(action.mcpServerId);
        }}
      >
        {action.label}
      </button>
    );
  switch (step.kind) {
    case "closed":
      // A closed attempt is the dialog going away: it has nothing left to say.
      return <></>;
    case "token-form":
      return (
        <TokenForm
          step={step}
          onSubmit={attempt.submitToken}
          onSignIn={() => void attempt.startSignIn()}
          onCancel={onClose}
        />
      );
    case "wait":
      return (
        <>
          <Wait text={step.text} note={step.closingNote} />
          {step.button !== null && (
            <div className="setup-acts">
              <button
                type="button"
                className="btn btn--quiet"
                autoFocus
                onClick={step.button.kind === "close" ? onClose : attempt.cancelSignIn}
              >
                {step.button.label}
              </button>
            </div>
          )}
        </>
      );
    case "sign-in-waiting":
      return <WaitingView step={step} attempt={attempt} />;
    case "sign-in-refused":
      return (
        <>
          <p className="fl-err setup-error" role="alert">
            {step.message}
          </p>
          {step.closingNote !== null && <p className="url-note">{step.closingNote}</p>}
          <div className="setup-acts">
            <button type="button" className="btn btn--quiet" onClick={attempt.cancelSignIn}>
              {step.cancel.label}
            </button>
            <button
              type="button"
              className="btn btn--accent"
              autoFocus
              onClick={() => void attempt.startSignIn()}
            >
              {step.startAgain.label}
            </button>
          </div>
        </>
      );
    case "read-failed":
      return (
        <>
          <Warning icon={<QuestionIcon size={14} />}>
            <b>{step.headline}</b> {step.body}
          </Warning>
          {step.closingNote !== null && <p className="url-note">{step.closingNote}</p>}
          <div className="setup-acts">
            {closeButton(step.close.label)}
            <button type="button" className="btn btn--accent" onClick={attempt.retryRead}>
              {step.tryAgain.label}
            </button>
          </div>
        </>
      );
    case "ready":
      return (
        <>
          <ServerCard
            name={step.name}
            address={step.address ?? ""}
            end={<DoneMark>{step.summary}</DoneMark>}
          />
          <ToolList tools={step.tools} />
          {step.newServerNote !== null && (
            <p className="setup-lead url-note">{step.newServerNote}</p>
          )}
          <div className="setup-acts">
            {step.open === null ? (
              <button type="button" className="btn btn--accent" autoFocus onClick={onClose}>
                {step.close.label}
              </button>
            ) : (
              <>
                {closeButton(step.close.label)}
                {openButton(step.open, true)}
              </>
            )}
          </div>
        </>
      );
    case "failed":
      return (
        <>
          <Warning icon={<QuestionIcon size={14} />}>
            <b>{step.headline}</b> {step.detail}
          </Warning>
          {step.checkError !== null && (
            <p className="fl-err setup-error" role="alert">
              {step.checkError}
            </p>
          )}
          {step.closingNote !== null && <p className="url-note">{step.closingNote}</p>}
          <div className="setup-acts">
            {closeButton(step.close.label)}
            <button
              type="button"
              className="btn"
              aria-disabled={step.checkNow.busy}
              onClick={() => {
                if (!step.checkNow.busy) void attempt.checkNow();
              }}
            >
              {step.checkNow.label}
            </button>
            {openButton(step.open, false)}
          </div>
        </>
      );
    case "off":
      return (
        <>
          <p className="setup-lead">{step.text}</p>
          <div className="setup-acts">
            {step.open === null ? (
              <button type="button" className="btn btn--accent" autoFocus onClick={onClose}>
                {step.close.label}
              </button>
            ) : (
              <>
                {closeButton(step.close.label)}
                {openButton(step.open, true)}
              </>
            )}
          </div>
        </>
      );
    case "ended":
      return (
        <>
          <Warning icon={<QuestionIcon size={14} />}>
            <b>{step.headline}</b> {step.body}
          </Warning>
          <div className="setup-acts">
            {closeButton(step.close.label)}
            {openButton(step.open, false)}
          </div>
        </>
      );
  }
}

/**
 * Renders the waiting step of a sign-in: a card with the heading, who asks
 * for the approval, what to do in the browser and the paste, and under it the
 * way to leave and the button that opens the sign-in page. The browser opens
 * only when the user presses that button, after reading the host in the card.
 * It reads "Open again" once it was pressed.
 *
 * The open button takes the focus, so Enter opens the page. It is the primary
 * button, except while the paste field is open: then "Finish sign-in" is the
 * one primary button, and opening the page again is the second choice.
 * The wait line has a spinner only while the browser is waited for: not before
 * the press, and not after the page failed to open.
 */
function WaitingView({
  step,
  attempt,
}: {
  readonly step: Extract<UrlServerStep, { kind: "sign-in-waiting" }>;
  readonly attempt: UrlServerAttempt;
}): JSX.Element {
  const [pasted, setPasted] = useState("");
  const [showsPaste, setShowsPaste] = useState(false);
  const { paste } = step;
  const pasteShown = paste.alwaysShown || showsPaste;
  return (
    <div className="url-waiting">
      <MarkedRows>
        <MarkedRow
          mark={<ToolsIcon size={18} />}
          name={step.heading}
          detail={step.approval}
          end={null}
        >
          <WaitLine text={step.instruction} spinning={step.waiting} />
          {step.openError !== null && (
            <p className="fl-err" role="alert">
              {step.openError}
            </p>
          )}
          {pasteShown && (
            <form
              className="url-paste"
              onSubmit={(event) => {
                event.preventDefault();
                if (pasted.trim() !== "") void attempt.finishSignInByPaste(pasted);
              }}
            >
              <FormField label={paste.label} error={paste.problem}>
                <input
                  autoFocus={paste.question !== null}
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
                  {paste.submit}
                </button>
              </div>
            </form>
          )}
        </MarkedRow>
      </MarkedRows>
      {paste.question !== null && !pasteShown && (
        <p className="url-stuck">
          {paste.question}
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              setShowsPaste(true);
            }}
          >
            {paste.toggle}
          </button>
        </p>
      )}
      {step.closingNote !== null && <p className="url-note">{step.closingNote}</p>}
      <div className="setup-acts">
        <button type="button" className="btn btn--quiet" onClick={attempt.cancelSignIn}>
          {step.cancel.label}
        </button>
        <button
          type="button"
          className={pasteShown ? "btn" : "btn btn--accent"}
          autoFocus
          onClick={() => void attempt.openSignInPage()}
        >
          <ExternalIcon size={14} />
          {step.open.label}
        </button>
      </div>
    </div>
  );
}
