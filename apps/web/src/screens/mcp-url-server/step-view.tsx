import { useEffect, useRef, useState, type JSX } from "react";
import { Link } from "@tanstack/react-router";
import type {
  OpenServerAction,
  UrlServerAttempt,
  UrlServerLaterStep,
  UrlServerStep,
} from "@hercule/client-core/mcp-servers";
import { buildButtonClassName, Button, Field, Input } from "@hercule/ui";
import { TokenForm } from "./token-form";
import { WaitLine } from "./wait-line";

/**
 * Draws a step of a dialog that writes a server added by URL, from what
 * `describeUrlServerStep` returned. The words and the actions are the step's;
 * this view places the buttons, and draws the sign-in page as a link, because
 * the web app cannot ask the browser to open it. `attempt` takes the user's
 * presses. `onClose` closes the dialog.
 */
export function StepView({
  step,
  attempt,
  onClose,
}: {
  readonly step: UrlServerLaterStep;
  readonly attempt: UrlServerAttempt;
  readonly onClose: () => void;
}): JSX.Element {
  const note =
    step.closingNote === null ? null : (
      <span className="mr-auto text-fine text-faint">{step.closingNote}</span>
    );
  switch (step.kind) {
    case "closed":
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
          <WaitLine>{step.text}</WaitLine>
          {step.button === null ? (
            step.closingNote === null ? null : (
              <p className="text-fine text-faint">{step.closingNote}</p>
            )
          ) : (
            <Footer note={note}>
              <Button
                type="button"
                autoFocus
                onClick={step.button.kind === "close" ? onClose : attempt.cancelSignIn}
              >
                {step.button.label}
              </Button>
            </Footer>
          )}
        </>
      );
    case "sign-in-waiting":
      return <WaitingStep step={step} attempt={attempt} />;
    case "sign-in-refused":
      return (
        <>
          <p className="text-row text-fail" role="alert">
            {step.message}
          </p>
          <Footer note={note}>
            <Button type="button" onClick={attempt.cancelSignIn}>
              {step.cancel.label}
            </Button>
            <Button
              type="button"
              variant="form"
              autoFocus
              onClick={() => void attempt.startSignIn()}
            >
              {step.startAgain.label}
            </Button>
          </Footer>
        </>
      );
    case "read-failed":
      return (
        <>
          <p className="text-row text-fail" role="alert">
            {step.headline} {step.body}
          </p>
          <Footer note={note}>
            <Button type="button" onClick={onClose}>
              {step.close.label}
            </Button>
            <Button type="button" variant="form" onClick={attempt.retryRead}>
              {step.tryAgain.label}
            </Button>
          </Footer>
        </>
      );
    case "ready":
      return (
        <>
          <div className="flex flex-col gap-2">
            <p className="text-row text-ink" role="status">
              <b className="font-emph">{step.name}</b>{" "}
              <span className="text-muted">{step.summary}</span>
            </p>
            {step.tools.length === 0 ? null : (
              <ul className="flex max-h-[30vh] flex-col overflow-y-auto">
                {step.tools.map((tool) => (
                  <li
                    key={tool.name}
                    className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3 border-t border-line-soft py-1 text-fine first:border-t-0"
                  >
                    <code className="font-mono break-words text-ink">{tool.name}</code>
                    <span className="text-muted">{tool.description}</span>
                  </li>
                ))}
              </ul>
            )}
            {step.newServerNote === null ? null : (
              <p className="text-fine text-faint">{step.newServerNote}</p>
            )}
          </div>
          <Footer note={note}>
            <Button type="button" onClick={onClose}>
              {step.close.label}
            </Button>
            <OpenServerLink action={step.open} onClose={onClose} />
          </Footer>
        </>
      );
    case "failed":
      return (
        <>
          <p className="text-row text-fail" role="alert">
            {step.headline} {step.detail}
          </p>
          {step.checkError === null ? null : (
            <p className="text-fine text-fail" role="alert">
              {step.checkError}
            </p>
          )}
          <Footer note={note}>
            <Button type="button" onClick={onClose}>
              {step.close.label}
            </Button>
            <OpenServerLink action={step.open} onClose={onClose} />
            <Button
              type="button"
              variant="form"
              aria-disabled={step.checkNow.busy}
              onClick={() => {
                if (!step.checkNow.busy) void attempt.checkNow();
              }}
            >
              {step.checkNow.label}
            </Button>
          </Footer>
        </>
      );
    case "off":
      return (
        <>
          <p className="text-row text-muted" role="status">
            {step.text}
          </p>
          <Footer note={note}>
            <Button type="button" onClick={onClose}>
              {step.close.label}
            </Button>
            <OpenServerLink action={step.open} onClose={onClose} />
          </Footer>
        </>
      );
    case "ended":
      return (
        <>
          <p className="text-row text-muted" role="status">
            <b className="font-emph text-ink">{step.headline}</b> {step.body}
          </p>
          <Footer note={note}>
            <OpenServerLink action={step.open} onClose={onClose} />
            <Button type="button" onClick={onClose}>
              {step.close.label}
            </Button>
          </Footer>
        </>
      );
  }
}

/** Draws the row of buttons at the foot of a step, with what closing does on its left. */
function Footer({
  note,
  children,
}: {
  readonly note: JSX.Element | null;
  readonly children: JSX.Element | JSX.Element[];
}): JSX.Element {
  return (
    <div className="flex items-center justify-end gap-1.5 border-t border-line-soft pt-3">
      {note}
      {children}
    </div>
  );
}

/** Draws the link from a dialog to the server's page, or nothing when the step offers none. It closes the dialog, because the dialog covers the page it leads from. */
function OpenServerLink({
  action,
  onClose,
}: {
  readonly action: OpenServerAction | null;
  readonly onClose: () => void;
}): JSX.Element | null {
  if (action === null) return null;
  return (
    <Link
      to="/settings/mcp-servers/$id"
      params={{ id: action.mcpServerId }}
      onClick={onClose}
      className={buildButtonClassName("form", "")}
    >
      {action.label}
    </Link>
  );
}

/**
 * Draws the waiting step: the host that asks for the approval, the link that
 * opens the sign-in page, and the field for the address the browser ended on.
 * The web app has no listener, so the paste is the only way back and its field
 * is always shown.
 */
function WaitingStep({
  step,
  attempt,
}: {
  readonly step: Extract<UrlServerStep, { kind: "sign-in-waiting" }>;
  readonly attempt: UrlServerAttempt;
}): JSX.Element {
  const [pasted, setPasted] = useState("");
  // React focuses only fields and buttons for `autoFocus`, not a link, so the link is focused here.
  const openRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    openRef.current?.focus();
  }, []);
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (pasted.trim() !== "") void attempt.finishSignInByPaste(pasted);
      }}
    >
      <p className="text-row font-emph text-ink">{step.heading}</p>
      {/* A host with no hyphen has no place to break, so it breaks anywhere: its end names who asks. */}
      <p className="text-row break-words text-ink">{step.approval}</p>
      <p className="text-row text-muted">{step.instruction}</p>
      <div>
        <a
          href={step.open.url}
          target="_blank"
          rel="noopener noreferrer"
          ref={openRef}
          onClick={() => void attempt.openSignInPage()}
          className={buildButtonClassName(
            "form",
            "max-w-full text-left leading-tight whitespace-normal break-words",
          )}
        >
          {step.open.label}
        </a>
      </div>
      <Field id="mcp-url-callback" label={step.paste.label} error={step.paste.problem ?? undefined}>
        <Input
          id="mcp-url-callback"
          spellCheck={false}
          autoComplete="off"
          placeholder="http://127.0.0.1:…/callback?code=…"
          value={pasted}
          onChange={(event) => {
            setPasted(event.target.value);
          }}
        />
      </Field>
      {step.closingNote === null ? null : (
        <p className="text-fine text-faint">{step.closingNote}</p>
      )}
      <Footer note={null}>
        <Button type="button" onClick={attempt.cancelSignIn}>
          {step.cancel.label}
        </Button>
        <Button type="submit" variant="form" disabled={pasted.trim() === ""}>
          {step.paste.submit}
        </Button>
      </Footer>
    </form>
  );
}
