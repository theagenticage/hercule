import { useState, type JSX } from "react";
import {
  describeClosing,
  describeSignInWaiting,
  type UrlServerFlowState,
} from "@hercule/client-core/mcp-servers";
import { buildButtonClassName, Button, Field, Input } from "@hercule/ui";
import type { UrlServerFlow } from "../../app/mcp-url-server-flow";
import { WaitLine } from "./wait-line";

/**
 * Draws the steps of a sign-in through the browser, from the attempt's
 * `signing-in` state. The web app cannot catch the browser's return, so the
 * waiting step shows the sign-in page as a link and asks the user to paste
 * the address the browser ends on.
 *
 * - `starting` and `finishing`: a wait;
 * - `waiting`: who asks for the approval, the link, and the paste field;
 * - `refused`: why the sign-in ended, with Start again.
 *
 * Cancel returns to the dialog's form, where the pasted token is the other
 * way to sign in.
 */
export function SignInSteps({
  flow,
  state,
}: {
  readonly flow: UrlServerFlow;
  readonly state: Extract<UrlServerFlowState, { kind: "signing-in" }>;
}): JSX.Element {
  const { step } = state;
  const closingNote = describeClosing(state);
  const note = closingNote === null ? null : <p className="text-fine text-faint">{closingNote}</p>;
  switch (step.kind) {
    case "starting":
      return (
        <>
          <WaitLine>Preparing the sign-in.</WaitLine>
          {note}
          <SignInFooter onCancel={flow.cancelSignIn} />
        </>
      );
    case "finishing":
      return (
        <>
          <WaitLine>Finishing the sign-in.</WaitLine>
          {note}
        </>
      );
    case "refused":
      return (
        <>
          <p className="text-row text-fail" role="alert">
            {step.message}
          </p>
          <SignInFooter onCancel={flow.cancelSignIn}>
            <Button type="button" variant="form" onClick={flow.startSignIn}>
              Start again
            </Button>
          </SignInFooter>
        </>
      );
    case "waiting":
      return <WaitingStep flow={flow} step={step} note={note} />;
  }
}

/** Draws the waiting step: the link to the sign-in page and the field for the address the browser ended on. */
function WaitingStep({
  flow,
  step,
  note,
}: {
  readonly flow: UrlServerFlow;
  readonly step: Extract<
    Extract<UrlServerFlowState, { kind: "signing-in" }>["step"],
    { kind: "waiting" }
  >;
  readonly note: JSX.Element | null;
}): JSX.Element {
  const [pasted, setPasted] = useState("");
  const words = describeSignInWaiting({
    approvalHost: step.approvalHost,
    returnBy: step.returnBy,
    openedByApp: false,
  });
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (pasted.trim() !== "") flow.finishSignInByPaste(pasted);
      }}
    >
      <p className="text-row font-emph text-ink">{words.heading}</p>
      <p className="text-row text-ink">{words.approval}</p>
      <p className="text-row text-muted">{words.instruction}</p>
      <div>
        <a
          href={step.authorizationUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={buildButtonClassName("form", "")}
        >
          {words.openLabel}
        </a>
      </div>
      <Field id="mcp-url-callback" label={words.pasteLabel} error={step.pasteProblem ?? undefined}>
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
      {note}
      <SignInFooter onCancel={flow.cancelSignIn}>
        <Button type="submit" variant="form" disabled={pasted.trim() === ""}>
          {words.pasteSubmit}
        </Button>
      </SignInFooter>
    </form>
  );
}

/** Draws the footer of a sign-in step: Cancel, then `children`. */
function SignInFooter({
  onCancel,
  children,
}: {
  readonly onCancel: () => void;
  readonly children?: JSX.Element;
}): JSX.Element {
  return (
    <div className="flex items-center justify-end gap-1.5 border-t border-line-soft pt-3">
      <Button type="button" onClick={onCancel}>
        Cancel
      </Button>
      {children}
    </div>
  );
}
