import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { readErrorMessage, type HerculeClient } from "@hercule/client-core";
import type { McpServer } from "@hercule/contract";
import {
  NEW_SERVER_NOTE,
  describeClosing,
  describeOffOutcome,
  describeReadyTools,
  type FlowProblem,
  type ServerOutcome,
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
 * - `openServer` is `true` for the Add dialog, which offers "Open <name>" as
 *   the way to the new server's page. A dialog opened on a server's own page
 *   or on a thread's line has no such button.
 */
export function FollowSteps({
  client,
  flow,
  state,
  fallbackServer,
  openServer,
  onClose,
}: {
  readonly client: HerculeClient;
  readonly flow: UrlServerFlow;
  readonly state: Exclude<UrlServerFlowState, { kind: "form" }>;
  readonly fallbackServer: McpServer | null;
  readonly openServer: boolean;
  readonly onClose: () => void;
}): JSX.Element {
  const closingNote = describeClosing(state);
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
            {openServer && state.reason === "moved" && state.mcpServerId !== null ? (
              <Link
                to="/settings/mcp-servers/$id"
                params={{ id: state.mcpServerId }}
                onClick={onClose}
                className={buildButtonClassName("form", "")}
              >
                Open {state.name ?? "server"}
              </Link>
            ) : null}
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
          client={client}
          flow={flow}
          outcome={state.outcome}
          server={server}
          mcpServerId={state.mcpServerId}
          problem={state.problem}
          closingNote={closingNote}
          openServer={openServer}
          onClose={onClose}
        />
      );
    }
  }
}

/** Draws the step of a followed server's outcome. */
function Outcome({
  client,
  flow,
  outcome,
  server,
  mcpServerId,
  problem,
  closingNote,
  openServer,
  onClose,
}: {
  readonly client: HerculeClient;
  readonly flow: UrlServerFlow;
  readonly outcome: ServerOutcome;
  readonly server: McpServer | null;
  readonly mcpServerId: string;
  readonly problem: FlowProblem | null;
  readonly closingNote: string | null;
  readonly openServer: boolean;
  readonly onClose: () => void;
}): JSX.Element {
  const check = useMutation({
    mutationFn: () => client.mcpServer.check({ params: { id: mcpServerId } }),
  });
  const name = server?.name ?? "server";
  const openButton = !openServer ? null : (
    <Link
      to="/settings/mcp-servers/$id"
      params={{ id: mcpServerId }}
      onClick={onClose}
      className={buildButtonClassName("form", "")}
    >
      Open {name}
    </Link>
  );
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
          {footer(outcome.newServer ? openButton : null, "Done")}
        </>
      );
    case "needs-token":
      return server === null ? (
        <WaitLine>Reading the server.</WaitLine>
      ) : (
        <TokenForm
          server={server}
          problem={problem}
          refusal={outcome.refusedAgain ? outcome.detail : null}
          closingNote={closingNote}
          onSubmit={flow.submitToken}
          onSignIn={flow.startSignIn}
          onCancel={onClose}
        />
      );
    case "failed":
      return (
        <>
          <p className="text-row text-fail" role="alert">
            {outcome.status === "unreachable"
              ? "The server did not answer."
              : "The check ended in an error."}{" "}
            {outcome.detail}
          </p>
          {check.error === null ? null : (
            <p className="text-fine text-fail" role="alert">
              {readErrorMessage(check.error)}
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
              aria-disabled={check.isPending}
              onClick={() => {
                if (!check.isPending) check.mutate();
              }}
            >
              Check now
            </Button>
          </div>
        </>
      );
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
