import type { JSX, Ref } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  buildComposerFields,
  buildComposerPlaceholder,
  buildOptionsLabel,
  buildThreadWorkspaceLabel,
  findResumeBlockedReason,
  formatAccessMode,
  readThreadConfig,
} from "@hercule/client-core";
import {
  projectsQuery,
  providersQuery,
  resourcesQuery,
  runnersQuery,
  sessionQuery,
  threadsQuery,
  workspacesQuery,
} from "../../app/queries";
import {
  BranchIcon,
  LaptopIcon,
  MicIcon,
  PlusIcon,
  SendIcon,
  ShieldIcon,
  SlidersIcon,
  WorkspaceIcon,
} from "../../icons";
import { RequestDock } from "./dock";
import { ProviderLogo } from "./provider-logo";
import { QueuedInputs } from "./queued-inputs";
import "./composer.css";

/**
 * Renders the thread's composer, floating over the bottom of the transcript,
 * as the Bureau book's `.composer-wrap` draws it. From top to bottom:
 *
 * - the queued inputs, see `QueuedInputs`;
 * - the dock, while the session waits on a Request, see `RequestDock`;
 * - the card: the message field, then a row with Attach, the access mode,
 *   the model options when the model has any, the model, Dictate and Send;
 * - the lip under the card: where the thread works, and on which machine.
 *
 * The queued inputs and the dock work. The rest is drawn but does nothing
 * yet: the field is read-only, and it and every button carry
 * `aria-disabled`. The buttons still show their hover state, as every
 * control that is drawn before it is built does. The field is not
 * `disabled`, because the browser would restyle a disabled field and it
 * could not take focus. Every label comes from client-core, as the web app's
 * composer shows it for a thread that has started.
 *
 * `ref` receives the stack of the rows above, the card and the lip, whose
 * height is what the composer covers of the transcript, less the 18px the
 * stack sits above the pane's bottom edge.
 */
export function ThreadComposer({
  sessionId,
  ref,
}: {
  readonly sessionId: string;
  readonly ref?: Ref<HTMLDivElement>;
}): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { client } = controller;
  const session = useSuspenseQuery(sessionQuery(client, sessionId)).data;
  const instances = useSuspenseQuery(providersQuery(client)).data;
  const runners = useSuspenseQuery(runnersQuery(client)).data;
  const projects = useSuspenseQuery(projectsQuery(client)).data;
  const resources = useSuspenseQuery(resourcesQuery(client)).data;
  const workspaces = useSuspenseQuery(workspacesQuery(client)).data;
  const threads = useSuspenseQuery(threadsQuery(client)).data;

  const config = readThreadConfig({ kind: "active", session });
  const fields = buildComposerFields(
    // No runner is local to the desktop app. A started thread names its own
    // runner, which is the one every field reads.
    { instances, runners, localRunnerId: null, projects, resources, workspaces, sessions: threads },
    config,
    "active",
  );
  const workspaceLabel = buildThreadWorkspaceLabel(session, workspaces);
  const placeholder = buildComposerPlaceholder({
    readOnly: findResumeBlockedReason(session),
    busy: session.status === "busy",
    active: true,
    pick: fields.workspace.value,
    workspaces,
  });
  const { pill } = fields.model;

  return (
    <div className="composer-wrap">
      <div className="composer" ref={ref}>
        <QueuedInputs sessionId={sessionId} />
        {session.openRequest === null ? null : (
          <RequestDock
            key={session.openRequest.requestId}
            sessionId={sessionId}
            request={session.openRequest}
          />
        )}
        <div className="composer-card">
          <textarea
            className="composer-input"
            rows={1}
            readOnly
            aria-disabled="true"
            aria-label="Message"
            placeholder={placeholder}
          />
          <div className="composer-row">
            <button type="button" className="icon-btn" title="Attach" aria-disabled="true">
              <PlusIcon />
            </button>
            <button
              type="button"
              className="pick"
              title={fields.accessMode.locked ?? undefined}
              aria-disabled="true"
            >
              <ShieldIcon size={14} />
              {formatAccessMode(fields.accessMode.value)}
            </button>
            {fields.options === null ? null : (
              <button type="button" className="pick" aria-disabled="true">
                <SlidersIcon size={14} />
                {buildOptionsLabel(fields.options, config.options) ?? "Model options"}
              </button>
            )}
            <span className="spacer" />
            <button type="button" className="pick pick--pill" aria-disabled="true">
              {pill.providerId === null ? null : (
                <ProviderLogo providerId={pill.providerId} size={13} />
              )}
              {pill.account === null ? null : <span className="faint">{pill.account}</span>}
              <span className="pick-name">{pill.name ?? "No model"}</span>
            </button>
            <button type="button" className="icon-btn" title="Dictate" aria-disabled="true">
              <MicIcon />
            </button>
            <button type="button" className="send send--off" title="Send" aria-disabled="true">
              <SendIcon />
            </button>
          </div>
        </div>
        <div className="lip">
          {workspaceLabel.map((piece) => (
            // A label holds at most one piece of each kind.
            <span key={piece.kind} title={fields.workspace.locked ?? undefined}>
              {piece.kind === "branch" ? (
                <>
                  <BranchIcon size={13} />
                  <span className="mono">{piece.text}</span>
                  {piece.startedFrom === null ? null : (
                    <>
                      {" "}
                      <span className="faint">{piece.startedFrom}</span>
                    </>
                  )}
                </>
              ) : (
                <>
                  <WorkspaceIcon size={13} />
                  {piece.text}
                </>
              )}
            </span>
          ))}
          <span className="spacer" />
          <span title={fields.machine.locked ?? undefined}>
            <LaptopIcon size={13} />
            {fields.machine.label}
          </span>
        </div>
      </div>
    </div>
  );
}
