import { useState, type JSX } from "react";
import type { McpServer } from "@hercule/contract";
import { describeTokenForm, type FlowProblem } from "@hercule/client-core/mcp-servers";
import { Button, Field, Input } from "@hercule/ui";

/**
 * Returns the text to show for the problem of a token write, or `undefined`:
 * the controller's reason for the token field, any other reason, or the
 * failure's own message.
 */
const readProblemText = (problem: FlowProblem | null): string | undefined => {
  if (problem === null) return undefined;
  switch (problem.kind) {
    case "invalid":
      return (
        [problem.issues.token, problem.issues.other].filter((text) => text !== null).join(" ") ||
        undefined
      );
    case "failed":
      return problem.message;
    case "sign-in-unsupported":
      return problem.message;
    case "exists":
    case "plugin-origin":
      // These only answer a create, never a token write.
      return undefined;
  }
};

/**
 * The sign-in form of a server added by URL: what the server asks for, the
 * sign-in through the browser first when the server offers it (`onSignIn`),
 * one token field, and the note that the token stays on the controller. Add,
 * the page's "Replace token…" and "Sign in again…" and the "Sign in…" of a
 * thread line and of the band all draw it.
 *
 * For a server that offers the browser, the token field is the quieter second
 * choice: it shows after "Paste a token instead", or at once when a token
 * was refused or the controller says only a token works.
 *
 * The token lives in this form's state alone, so it is gone when the form
 * leaves the screen, whether the write was acknowledged or refused. The
 * attempt checks the token against the contract's rule when it is sent and
 * answers in `problem`.
 *
 * - `refusal` is the controller's reason when the token just saved was
 *   refused, shown above the field.
 * - `closingNote` is what closing the dialog now would do, or `null`.
 */
export function TokenForm({
  server,
  problem,
  refusal,
  closingNote,
  onSubmit,
  onSignIn,
  onCancel,
}: {
  readonly server: McpServer;
  readonly problem: FlowProblem | null;
  readonly refusal: string | null;
  readonly closingNote: string | null;
  readonly onSubmit: (token: string) => void;
  /** Starts the sign-in through the browser. */
  readonly onSignIn: () => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const [token, setToken] = useState("");
  const words = describeTokenForm(server);
  const problemText = readProblemText(problem);
  // The browser is offered unless the controller said it does not work for this server.
  const browser = problem?.kind === "sign-in-unsupported" ? null : words.browser;
  const [pasting, setPasting] = useState(browser === null || problemText !== undefined);
  if (browser !== null && !pasting) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-row text-muted">{browser.intro}</p>
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
          <Button
            type="button"
            onClick={() => {
              setPasting(true);
            }}
          >
            {browser.pasteToggle}
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
