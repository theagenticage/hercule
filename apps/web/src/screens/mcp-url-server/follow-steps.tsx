import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import type { McpServer } from "@hercule/contract";
import {
  NEW_SERVER_NOTE,
  describeClosing,
  describeFailedCheck,
  describeOffOutcome,
  describeOpenServerAction,
  describeReadyTools,
  type FlowProblem,
  type OpenServerAction,
  type ServerOutcome,
  type SignInEntry,
  type UrlServerFlowState,
} from "@hercule/client-core/mcp-servers";
import { buildButtonClassName, Button } from "@hercule/ui";
import type { UrlServerFlow } from "../../app/mcp-url-server-flow";
import { SignInSteps } from "./sign-in-steps";
import { TokenForm } from "./token-form";
import { WaitLine } from "./wait-line";

/**
 * Draws what a dialog shows once its attempt has written: waiting, the token
 * form again, the tools, or why the attempt cannot go on. The dialog's own
 * first step (the Add form, or the token form of a server that is not being
 * checked yet) is drawn by the dialog itself.
 *
 * - `server` is the record the dialog was opened for, used until the attempt
 *   has read a newer one.
 * - `openedOn` is where the dialog was opened: on the server's own page, or
 *   elsewhere (the Add dialog, a thread). Whether "Open <name>" is offered is
 *   decided by `describeOpenServerAction`, which offers it only when it leads
 *   somewhere new.
 */
export function FollowSteps({
  flow,
  state,
  fallbackServer,
  openedOn,
  entry,
  onClose,
}: {
  readonly flow: UrlServerFlow;
  readonly state: Exclude<UrlServerFlowState, { kind: "form" }>;
  readonly fallbackServer: McpServer | null;
  readonly openedOn: "server-page" | "elsewhere";
  /** The button that opened the dialog, which the token form it shows again opens as. */
  readonly entry: SignInEntry;
  readonly onClose: () => void;
}): JSX.Element {
  const closingNote = describeClosing(state);
  const openAction = describeOpenServerAction(state, openedOn);
  const closeRow = (
    <div className="flex items-center justify-end gap-1.5 border-t border-line-soft pt-3">
      {closingNote === null ? null : (
        <span className="mr-auto text-fine text-faint">{closingNote}</span>
      )}
      <Button type="button" onClick={onClose}>
        Close
      </Button>
    </div>
  );

  switch (state.kind) {
    case "writing":
      return (
        <>
          <WaitLine>
            {state.write === "create" ? "Asking the server what it needs." : "Saving the token."}
          </WaitLine>
          {closeRow}
        </>
      );
    case "signing-in":
      return <SignInSteps flow={flow} state={state} />;
    case "ended":
      return (
        <>
          <p className="text-row text-muted" role="status">
            {state.reason === "gone"
              ? `${state.name ?? "This server"} was removed, so there is nothing more to do here.`
              : (state.message ??
                `${state.name ?? "This server"} is reached with a Connection now, so its sign-in is the Connection's.`)}
          </p>
          <div className="flex items-center justify-end gap-1.5 border-t border-line-soft pt-3">
            {openAction === null ? null : <OpenServerLink action={openAction} onClose={onClose} />}
            <Button type="button" onClick={onClose}>
              Close
            </Button>
          </div>
        </>
      );
    case "following": {
      const server = state.server ?? fallbackServer;
      return (
        <Outcome
          flow={flow}
          outcome={state.outcome}
          server={server}
          problem={state.problem}
          entry={entry}
          closingNote={closingNote}
          openAction={openAction}
          onClose={onClose}
        />
      );
    }
  }
}

/** Draws the link from a dialog to the server's page. It closes the dialog, because the dialog covers the page it leads from. */
function OpenServerLink({
  action,
  onClose,
}: {
  readonly action: OpenServerAction;
  readonly onClose: () => void;
}): JSX.Element {
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

/** Draws the step of a followed server's outcome. */
function Outcome({
  flow,
  outcome,
  server,
  problem,
  entry,
  closingNote,
  openAction,
  onClose,
}: {
  readonly flow: UrlServerFlow;
  readonly outcome: ServerOutcome;
  readonly server: McpServer | null;
  readonly problem: FlowProblem | null;
  readonly entry: SignInEntry;
  readonly closingNote: string | null;
  readonly openAction: OpenServerAction | null;
  readonly onClose: () => void;
}): JSX.Element {
  const name = server?.name ?? "server";
  const openButton =
    openAction === null ? null : <OpenServerLink action={openAction} onClose={onClose} />;
  const footer = (extra: JSX.Element | null, closeLabel: string): JSX.Element => (
    <div className="flex items-center justify-end gap-1.5 border-t border-line-soft pt-3">
      {closingNote === null ? null : (
        <span className="mr-auto text-fine text-faint">{closingNote}</span>
      )}
      <Button type="button" onClick={onClose}>
        {closeLabel}
      </Button>
      {extra}
    </div>
  );

  switch (outcome.kind) {
    case "reading":
      return (
        <>
          <WaitLine>Reading the server.</WaitLine>
          {footer(null, "Close")}
        </>
      );
    case "checking":
      return (
        <>
          <WaitLine>Checking: asking the server for its tools.</WaitLine>
          {footer(null, "Close")}
        </>
      );
    case "read-failed":
      return (
        <>
          <p className="text-row text-fail" role="alert">
            The server could not be read, so what the check found is not known. It may have
            succeeded. {outcome.message}
          </p>
          <div className="flex items-center justify-end gap-1.5 border-t border-line-soft pt-3">
            <Button type="button" onClick={onClose}>
              Close
            </Button>
            <Button type="button" variant="form" onClick={flow.retryRead}>
              Try again
            </Button>
          </div>
        </>
      );
    case "ready":
      return (
        <>
          <div className="flex flex-col gap-2">
            <p className="text-row text-ink" role="status">
              <b className="font-emph">{name}</b>{" "}
              <span className="text-muted">{describeReadyTools(outcome.toolCount)}</span>
            </p>
            {server === null || server.tools.length === 0 ? null : (
              <ul className="flex max-h-[30vh] flex-col overflow-y-auto">
                {server.tools.map((tool) => (
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
            {outcome.newServer ? <p className="text-fine text-faint">{NEW_SERVER_NOTE}</p> : null}
          </div>
          {footer(openButton, "Done")}
        </>
      );
    case "needs-token":
      return server === null ? (
        <WaitLine>Reading the server.</WaitLine>
      ) : (
        <TokenForm
          server={server}
          problem={problem}
          entry={entry}
          refusal={outcome.refusedAgain ? outcome.detail : null}
          closingNote={closingNote}
          onSubmit={flow.submitToken}
          onSignIn={flow.startSignIn}
          onCancel={onClose}
        />
      );
    case "failed": {
      const failed = describeFailedCheck({
        status: outcome.status,
        detail: outcome.detail,
        server,
      });
      return (
        <>
          <p className="text-row text-fail" role="alert">
            {failed.headline} {failed.detail}
          </p>
          {flow.check.error === null ? null : (
            <p className="text-fine text-fail" role="alert">
              {flow.check.error}
            </p>
          )}
          <div className="flex items-center justify-end gap-1.5 border-t border-line-soft pt-3">
            {closingNote === null ? null : (
              <span className="mr-auto text-fine text-faint">{closingNote}</span>
            )}
            <Button type="button" onClick={onClose}>
              Close
            </Button>
            {openButton}
            <Button
              type="button"
              variant="form"
              aria-disabled={flow.check.busy}
              onClick={() => {
                if (!flow.check.busy) flow.checkNow();
              }}
            >
              Check now
            </Button>
          </div>
        </>
      );
    }
    case "off":
      return (
        <>
          <p className="text-row text-muted" role="status">
            {describeOffOutcome(outcome.saved)}
          </p>
          {footer(openButton, "Done")}
        </>
      );
  }
}
