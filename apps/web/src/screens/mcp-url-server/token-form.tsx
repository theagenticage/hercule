import { useState, type JSX } from "react";
import type { UrlServerStep } from "@hercule/client-core/mcp-servers";
import { Button, Field, Input } from "@hercule/ui";

/**
 * The sign-in form of a server added by URL: what the server asks for, the
 * sign-in through the browser first when the server offers it (`onSignIn`),
 * one token field, and the note that the token stays on the controller. Add,
 * the page's "Replace token…" and "Sign in again…" and the "Sign in…" of a
 * thread line and of the band all draw it from the same step.
 *
 * For a server that offers the browser, the token field is the quieter second
 * choice: it shows after "Paste a token instead", a quiet button under the
 * sentence that leaves the footer to Cancel and the browser, or at once when
 * the step's words say the form opens with `token`.
 *
 * The token lives in this form's state alone, so it is gone when the form
 * leaves the screen, whether the write was acknowledged or refused.
 */
export function TokenForm({
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
  const { words, refusedReason: refusal, closingNote, subject } = step;
  const [token, setToken] = useState("");
  const { browser, problemText } = words;
  const subjectLine =
    subject === null ? null : (
      <p className="text-row text-ink">
        <b className="font-emph">{subject.name}</b>{" "}
        <span className="font-mono text-fine text-muted break-all">{subject.address}</span>
      </p>
    );
  // The user's press of "Paste a token instead" adds to what the words say the form opens with.
  const [choseToken, setChoseToken] = useState(false);
  if (browser !== null && words.method === "browser" && !choseToken) {
    return (
      <div className="flex flex-col gap-3">
        {subjectLine}
        <p className="text-row text-muted">{browser.intro}</p>
        <Button
          type="button"
          className="-mt-1 -ml-2 self-start"
          onClick={() => {
            setChoseToken(true);
          }}
        >
          {browser.pasteToggle}
        </Button>
        {refusal === null ? null : (
          <p className="text-fine text-fail" role="alert">
            {refusal}
          </p>
        )}
        {words.offNote === null ? null : <p className="text-fine text-faint">{words.offNote}</p>}
        {closingNote === null ? null : <p className="text-fine text-faint">{closingNote}</p>}
        <div className="flex items-center justify-end gap-1.5 border-t border-line-soft pt-3">
          <Button type="button" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" variant="form" autoFocus onClick={onSignIn}>
            {browser.label}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (token !== "") onSubmit(token);
      }}
    >
      {subjectLine}
      <p className="text-row text-muted">{words.intro}</p>
      {refusal === null ? null : (
        <p className="text-fine text-fail" role="alert">
          {refusal}
        </p>
      )}
      <Field id="mcp-url-token" label="Token" error={problemText}>
        <Input
          id="mcp-url-token"
          type="password"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(event) => {
            setToken(event.target.value);
          }}
        />
      </Field>
      <p className="text-fine text-faint">{words.note}</p>
      {words.offNote === null ? null : <p className="text-fine text-faint">{words.offNote}</p>}
      {closingNote === null ? null : <p className="text-fine text-faint">{closingNote}</p>}
      <div className="flex items-center justify-end gap-1.5 border-t border-line-soft pt-3">
        <Button type="button" onClick={onCancel}>
          Cancel
        </Button>
        {browser === null ? null : (
          <Button type="button" onClick={onSignIn}>
            {browser.label}
          </Button>
        )}
        <Button type="submit" variant={browser === null ? "form" : "quiet"} disabled={token === ""}>
          {words.submitLabel}
        </Button>
      </div>
    </form>
  );
}
