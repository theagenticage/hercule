/**
 * The new-thread screen, as the Bureau book's `session-empty` page draws it:
 * the header, then a column in the middle of the pane with a face and a
 * question, the Draft Thread's composer, and the start cards.
 */
import { useRef, useState, useSyncExternalStore, type JSX } from "react";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import {
  addWorkspacePicks,
  appendToMessage,
  applyPicks,
  buildComposerPlaceholder,
  buildRecentModel,
  buildSubmission,
  findDraftSubject,
  isMutationRunning,
  joinPhraseText,
  listWorkspaceThreads,
  queryKeys,
  readErrorMessage,
  type ComposerPick,
  type ThreadPicks,
} from "@hercule/client-core";
import type { SessionSpawnInput } from "@hercule/contract";
import { useDraftThread } from "../../app/draft-thread";
import { buildDraftKey } from "../../app/pending-submissions";
import { threadsQuery } from "../../app/queries";
import { readRecentModels, rememberRecentModel } from "../../app/recent-models";
import { buildLook, Face } from "../../faces";
import { useShowsClassicScrollbar } from "../thread/classic-scrollbar";
import { useSendOnMenuCommand } from "../thread/send-key";
import { DraftComposer } from "./draft-composer";
import { DraftHeader } from "./draft-header";
import { StartCards } from "./start-cards";
import "../thread/composer.css";
import "./new-thread.css";

/** What one start carried: the request, and the draft it was built from. */
interface SentDraft {
  readonly input: SessionSpawnInput;
  readonly text: string;
  readonly picks: ThreadPicks;
  /** The account the thread runs on, which a picked model is remembered with. */
  readonly instanceId: string | null;
}

/**
 * Renders a Draft Thread in `projectId`, joining `workspaceId` when it is set.
 * Either can be `null`: a draft in no project is allowed, and has no
 * workspace to pick until it has a project.
 *
 * From top to bottom:
 *
 * - the header, with the project and the threads of the workspace the draft
 *   joins;
 * - a face and a question, "What should the agent do in webshop?", then the
 *   lead: where the thread will work and on which machine, or why it cannot
 *   start yet;
 * - the composer, see `DraftComposer`;
 * - the start cards, when the draft is in a project, see `StartCards`.
 *
 * ⏎ or Send starts the thread with what the composer shows, and opens it once
 * the controller has started it. A failed start keeps the draft and shows
 * why under the composer's row, also when the user left while it ran and
 * came back.
 *
 * What the draft holds, the text and the picks, is kept in memory for as
 * long as the app runs, in the pending submissions under the draft's project
 * and workspace, so it is still there when the user comes back to the same
 * place. The route mounts the screen keyed by that place, so every other
 * place starts afresh.
 *
 * Everything it reads is in the cache before it renders, see
 * `useDraftThread`.
 */
export function DraftScreen({
  projectId,
  workspaceId,
}: {
  readonly projectId: string | null;
  readonly workspaceId: string | null;
}): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { client, pendingSubmissions } = controller;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const key = buildDraftKey(projectId, workspaceId);
  const pending = useSyncExternalStore(pendingSubmissions.subscribe, () =>
    pendingSubmissions.read(key),
  );
  const view = useDraftThread({ projectId, workspaceId });
  if (view === null) {
    throw new Error(
      "The new-thread screen rendered before its settings and profiles were read. The route's loader reads them, so the screen must be mounted by that route.",
    );
  }
  const { fields, catalogs, joinedWorkspace } = view;
  const { projects, workspaces } = catalogs;
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  // The start is keyed by the draft's place, so a screen mounted again while
  // its start is still on the way, after the user left and came back, finds
  // it running and does not start the thread twice.
  const startKey = ["draft-start", key];
  const starting = useIsMutating({ mutationKey: startKey }) > 0;

  const workspace = fields.workspace.value;
  const project = projects.find((each) => each.id === projectId);
  const subject = findDraftSubject(workspace, workspaces, projectId, projects);

  const spawn = useMutation({
    mutationKey: startKey,
    mutationFn: (sent: SentDraft) => client.session.spawn({ payload: sent.input }),
    // Registered here rather than passed to `mutate`, so the draft is cleared
    // even when the user has left the screen before the start returns.
    onSuccess: (session, sent) => {
      // The thread screen opens on this session without reading it again.
      queryClient.setQueryData(queryKeys.session(session.id), session);
      void queryClient.invalidateQueries({ queryKey: threadsQuery(client).queryKey });
      pendingSubmissions.clearSent(key, sent);
      const recent = buildRecentModel(sent.picks, sent.instanceId);
      if (recent !== null) rememberRecentModel(controller.url, recent);
    },
    // Kept in the draft rather than read from `spawn.error`: a screen mounted
    // again, after the user left and came back, has a mutation of its own,
    // which never saw this start fail.
    onError: (error) => {
      pendingSubmissions.recordFailure(key, readErrorMessage(error));
    },
  });
  // Whether the column is scrolled away from its top, so part of it is under
  // the header. Only then does it fade under the header (thread-header.css).
  const [scrolled, setScrolled] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const showsScrollbar = useShowsClassicScrollbar(scrollRef);
  const canSend = fields.blocked === null && pending.message.text.trim() !== "" && !starting;

  // Each pick is compared with the draft's own configuration, not with the
  // picks before it, so picking the configured value again removes the pick.
  const pick = (steps: readonly ComposerPick[]): void => {
    const { picks } = pendingSubmissions.read(key);
    pendingSubmissions.writePicks(key, applyPicks(catalogs, view.base, picks, steps));
  };
  const submit = (): void => {
    if (!canSend || isMutationRunning(queryClient, startKey)) return;
    const submission = buildSubmission(
      { kind: "draft", config: view.base },
      addWorkspacePicks(pending.picks, workspace, workspaces),
      pending.message,
    );
    pendingSubmissions.clearFailure(key);
    spawn.mutate(
      {
        input: submission.input,
        text: pending.message.text,
        picks: pending.picks,
        instanceId: view.config.instanceId,
      },
      {
        onSuccess: (session) => {
          void navigate({ to: "/threads/$sessionId", params: { sessionId: session.id } });
        },
      },
    );
  };
  useSendOnMenuCommand(submit);

  return (
    <>
      <DraftHeader
        projectId={projectId}
        projects={projects}
        tabs={listWorkspaceThreads(joinedWorkspace, catalogs.sessions)}
        runners={catalogs.runners}
      />
      <div
        ref={scrollRef}
        className={`hello${scrolled ? " is-scrolled" : ""}${showsScrollbar ? " has-scrollbar" : ""}`}
        onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}
      >
        <div className="column">
          <div className="newbie">
            <span className="newbie-face">
              <Face
                look={buildLook(
                  project === undefined ? "New thread" : `New thread in ${project.name}`,
                )}
                pose="idle"
                size={68}
              />
            </span>
            <h1>
              {subject === null
                ? "What should the agent do?"
                : `What should the agent do in ${subject.label}?`}
            </h1>
            {fields.blocked === null ? (
              <p>{joinPhraseText(fields.lead ?? [])}</p>
            ) : (
              <p>
                <b className="newbie-blocked">Can&apos;t start yet.</b> {fields.blocked.reason}.
              </p>
            )}
          </div>
          <DraftComposer
            view={view}
            text={pending.message.text}
            placeholder={buildComposerPlaceholder({
              readOnly: null,
              busy: false,
              active: false,
              pick: workspace,
              workspaces,
            })}
            canSend={canSend}
            error={pending.failure ?? null}
            readRecent={() => readRecentModels(controller.url)}
            fieldRef={fieldRef}
            onTextChange={(text) => {
              pendingSubmissions.writeText(key, text);
            }}
            onPick={pick}
            onSubmit={submit}
          />
          {projectId === null ? null : (
            <StartCards
              projectId={projectId}
              onStart={(message) => {
                const { text } = pendingSubmissions.read(key).message;
                pendingSubmissions.writeText(key, appendToMessage(text, message));
                fieldRef.current?.focus();
              }}
            />
          )}
        </div>
      </div>
    </>
  );
}
