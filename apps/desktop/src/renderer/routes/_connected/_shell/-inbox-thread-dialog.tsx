import { lazy, Suspense, useRef, useState, useSyncExternalStore, type JSX } from "react";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  applyThreadChoice,
  buildOptionsLabel,
  buildRecentModel,
  buildSubmission,
  formatRepoName,
  listProjectRepos,
  queryKeys,
  readErrorMessage,
  type DraftView,
  type SignInTarget,
  type ThreadChoice,
} from "@hercule/client-core";
import {
  THREAD_STARTERS,
  buildPicksForProjectChoice,
  buildThreadStartView,
  writeStarterMessage,
  type ProjectLookup,
  type ThreadStarter,
} from "@hercule/client-core/inbox";
import type { Workspace } from "@hercule/contract";
import { requireSignedIn, type AccountScope } from "../../../app/account-scope";
import { useDraftReads } from "../../../app/draft-thread";
import { pluginsQuery, projectMatchQuery } from "../../../app/queries";
import { readReason } from "../../../app/read-reason";
import { readRecentModels } from "../../../app/recent-models";
import type {
  SentThread,
  ThreadStartDraft,
  ThreadStartDraftEdit,
  ThreadStartDrafts,
} from "../../../app/thread-start-drafts";
import { buildLook } from "../../../faces";
import { useComposerImages } from "../../../screens/attachments/use-composer-images";
import { DraftComposer } from "../../../screens/new-thread/draft-composer";
import { useDraftSkills } from "../../../screens/new-thread/use-draft-skills";
import { pickProjectTint } from "../../../screens/project-tile";
import { useSendOnMenuCommand } from "../../../screens/session/send-key";
import { ThreadDialog } from "../../../screens/inbox/thread-dialog";
import { ThingChips } from "../../../screens/inbox/thread-dialog-chips";
import { ProjectPick } from "../../../screens/inbox/thread-dialog-project-pick";

// The transcript is loaded when a thread has started, which the Inbox's own chunk leaves out.
const ThreadFirstMoments = lazy(() =>
  import("../../../screens/thread/thread-first-moments").then((module) => ({
    default: module.ThreadFirstMoments,
  })),
);

// The sign-in dialog is loaded the first time Sign in opens it (spec 17 §Performance).
const ProviderLoginDialog = lazy(() =>
  import("../../../screens/provider-login").then((module) => ({
    default: module.ProviderLoginDialog,
  })),
);

/** The shelf key of the images a dialog holds, in the pending submissions. */
export const buildThreadStartImagesKey = (draftKey: string): string => `inbox-thread:${draftKey}`;

/** The thread that started from the dialog, once the controller has answered. */
export interface StartedThread {
  readonly sessionId: string;
  readonly title: string;
  readonly summary: string;
  readonly thingCount: number;
}

/** Why the composer's picks wait for a project. */
const CHOOSE_PROJECT_FIRST = "Choose a project first";

/**
 * Renders the start-thread dialog for the unsent `draft`, kept in `drafts`
 * under `draftKey`: the things as chips, the starters, the real composer and
 * the project pick. With `started` set, it shows the thread that started
 * instead.
 *
 * It reads and writes the draft in `drafts` with every change, so what the
 * user wrote is kept whatever happens to the dialog. Sending calls `onSend`
 * with the request and does not wait for it: the caller sends, and passes
 * `isStarting` while it is on its way and `failure` through the draft when it
 * fails. ⌘↩, the send button and the app menu's Send all call the same
 * function. The mutation in `onSend`'s caller refuses a second send while one
 * is on its way.
 *
 * The project is the user's choice when they made one, else the controller's
 * match of the things (`externalEntity.matchProject`), which follows the
 * chips. With no project the composer's picks wait, and the send, and ⌘↩ opens
 * the project menu. "No project" starts with approval-required access, since
 * the thread has no checkout to protect.
 *
 * Orchestrating: it owns the reads of the match and of the draft's records,
 * and every write to the draft.
 */
export function InboxThreadDialog({
  drafts,
  draftKey,
  started,
  isStarting,
  onSend,
  onOpenThread,
  onClose,
}: {
  readonly drafts: ThreadStartDrafts;
  readonly draftKey: string;
  readonly started: StartedThread | null;
  readonly isStarting: boolean;
  readonly onSend: (sent: SentThread) => void;
  readonly onOpenThread: (sessionId: string) => void;
  readonly onClose: () => void;
}): JSX.Element | null {
  // Read here rather than by the screen that draws the dialog, so each key typed renders only the dialog.
  const draft = useSyncExternalStore(drafts.subscribe, () => drafts.read(draftKey));
  return draft === undefined ? null : (
    <ThreadStartForm
      drafts={drafts}
      draftKey={draftKey}
      draft={draft}
      started={started}
      isStarting={isStarting}
      onSend={onSend}
      onOpenThread={onOpenThread}
      onClose={onClose}
    />
  );
}

function ThreadStartForm({
  drafts,
  draftKey,
  draft,
  started,
  isStarting,
  onSend,
  onOpenThread,
  onClose,
}: {
  readonly drafts: ThreadStartDrafts;
  readonly draftKey: string;
  readonly draft: ThreadStartDraft;
  readonly started: StartedThread | null;
  readonly isStarting: boolean;
  readonly onSend: (sent: SentThread) => void;
  readonly onOpenThread: (sessionId: string) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const { bridge, controller } = useRouteContext({ from: "/_connected" });
  const { client, pendingSubmissions } = controller;
  const plugins = useSuspenseQuery(pluginsQuery(client)).data;
  const reads = useDraftReads(true);
  const match = useQuery({
    ...projectMatchQuery(
      client,
      draft.things.map((thing) => thing.id),
    ),
  });
  const queryClient = useQueryClient();
  const [signIn, setSignIn] = useState<SignInTarget | null>(null);
  const inspection = useMutation({
    // The scope is read when the user opens the menu and travels with the request, so an answer
    // that arrives after another account signed in does not write into that account's cache.
    mutationFn: ({ id, scope }: { id: string; scope: AccountScope }) => {
      requireSignedIn(scope);
      return client.workspace.inspect({ params: { id } });
    },
    onSuccess: (current, { scope }) => {
      if (!scope.isCurrent()) return;
      queryClient.setQueryData<readonly Workspace[]>(queryKeys.workspaces(), (records) =>
        records?.map((each) => (each.id === current.id ? current : each)),
      );
    },
  });
  const imagesKey = buildThreadStartImagesKey(draftKey);
  const shelf = useSyncExternalStore(
    pendingSubmissions.subscribe,
    () => pendingSubmissions.read(imagesKey).message.attachments,
  );
  const [refusal, setRefusal] = useState<string | null>(null);
  const fieldRef = useRef<HTMLElement>(null);
  const replaceMessageRef = useRef<(text: string) => void>(null);
  const openProjectMenuRef = useRef<() => void>(null);

  if (reads === null) {
    throw new Error(
      "The start-thread dialog rendered before the settings and profiles were read. Open it through useInboxThread, which reads them first.",
    );
  }

  // The match of the previous chips is not kept while a new one loads: a project inferred from a
  // chip that was left out must not be sendable.
  const lookup: ProjectLookup = match.isError
    ? // A refresh that failed after an answer leaves the old answer in `data`, which must not
      // stay sendable. While the retry runs, the lookup is on its way again.
      match.isFetching
      ? { kind: "refetching" }
      : { kind: "failed", reason: readReason(match.error) }
    : match.data !== undefined
      ? { kind: "answered", match: match.data }
      : { kind: "loading" };
  const {
    view,
    projectName,
    projectPick,
    isProjectPicked,
    reason,
    pickReason,
    pickReasons,
    lookupFailed,
    sendBlock,
  } = buildThreadStartView({
    reads,
    draft: {
      chosenProject: draft.chosenProject,
      picks: draft.picks,
      text: draft.text,
      attachments: shelf,
    },
    lookup,
  });
  const { projects, resources } = view.catalogs;

  const images = useComposerImages({
    storeKey: imagesKey,
    shelf,
    imageInput: view.fields.model.imageInput,
    modelName: view.fields.model.modelName,
    readOnly: false,
  });
  const skills = useDraftSkills(view);
  const { blocked } = view.fields;
  // An attempt is sent as it was, so what the dialog shows now does not decide whether it can go.
  const { attempt } = draft;
  const canSend =
    attempt !== undefined ? !isStarting : sendBlock === null && !isStarting && !images.sendBlocked;

  /** Returns the draft as it is now, which a handler reads instead of the render it was made in. */
  const readLatest = (): ThreadStartDraft => drafts.read(draftKey) ?? draft;
  /** Records what the user changed in the draft, and removes the refusal that answered the old words. */
  const change = (patch: ThreadStartDraftEdit, answersFailure = false): void => {
    drafts.edit(draftKey, patch, { answersFailure });
    setRefusal(null);
  };

  const writeText = (text: string): void => {
    const current = readLatest();
    const isStarterText = text === writeStarterMessage(current.starter, current.things);
    change({ text, starter: isStarterText ? current.starter : "own" });
  };
  const pickStarter = (starter: ThreadStarter): void => {
    const text = writeStarterMessage(starter, readLatest().things);
    change({ starter, text });
    // Through the field, so ⌘Z there brings the words back.
    replaceMessageRef.current?.(text);
  };
  const leaveThingOut = (id: string): void => {
    const current = readLatest();
    if (current.things.length < 2) return;
    const things = current.things.filter((thing) => thing.id !== id);
    // Words and name that are still the defaults follow the things that are left.
    const followsStarter = current.text === writeStarterMessage(current.starter, current.things);
    const text = followsStarter ? writeStarterMessage(current.starter, things) : current.text;
    const followsTitle = current.title === current.things[0]?.title;
    change(
      { things, text, title: followsTitle ? (things[0]?.title ?? current.title) : current.title },
      true,
    );
    if (text !== current.text) replaceMessageRef.current?.(text);
  };
  const chooseProject = (id: string | null): void => {
    change({ chosenProject: id, picks: buildPicksForProjectChoice(readLatest().picks, id) }, true);
  };
  const choose = (picked: ThreadChoice): void => {
    change({ picks: applyThreadChoice(readLatest().picks, picked) }, true);
  };

  const start = (): void => {
    if (started !== null) return;
    const sentBefore = readLatest().attempt;
    if (sentBefore !== undefined) {
      if (!isStarting) onSend(sentBefore);
      return;
    }
    // The reason line says the match is on its way, and the send follows the answer.
    if (sendBlock === "matching") return;
    if (sendBlock === "no-project") {
      openProjectMenuRef.current?.();
      return;
    }
    if (!canSend) return;
    const current = readLatest();
    const title = current.title.trim();
    if (title === "") {
      setRefusal("Give the Task a name first.");
      return;
    }
    images.clearRefusal();
    const { input } = buildSubmission(view.resolved, { text: current.text, attachments: shelf });
    const sent: SentThread = {
      draftKey,
      input: {
        ...input,
        context: current.things.map((thing) => ({ kind: "entity", entityId: thing.id })),
        newTask: { title, entityIds: current.things.map((thing) => thing.id) },
        dedupKey: crypto.randomUUID(),
      },
      title,
      things: current.things,
      attachments: shelf,
      recent: buildRecentModel(current.picks, view.resolved),
      summary: describeStartedThread(projectName, view),
    };
    drafts.recordAttempt(draftKey, sent);
    onSend(sent);
  };
  useSendOnMenuCommand(start);

  const error =
    refusal ??
    draft.failure ??
    (inspection.error === null ? null : readErrorMessage(inspection.error)) ??
    (attempt !== undefined || blocked === null ? null : `Can’t start yet. ${blocked.reason}.`);

  return (
    <>
      <ThreadDialog
        look={buildLook(started?.title ?? draft.title)}
        platform={bridge.platform}
        onClose={onClose}
        phase={
          started === null
            ? {
                kind: "writing",
                title: draft.title,
                starters: THREAD_STARTERS,
                chosenStarter: draft.starter,
                reason,
                composer: (
                  <DraftComposer
                    view={view}
                    text={draft.text}
                    canSend={canSend}
                    error={error}
                    notice={images.notice}
                    attachments={{
                      ...images.attachments,
                      onFiles: (files) => {
                        const before = shelf.length;
                        images.attachments.onFiles(files);
                        if (
                          pendingSubmissions.read(imagesKey).message.attachments.length > before
                        ) {
                          change({});
                        }
                      },
                    }}
                    skills={skills}
                    readRecent={() => readRecentModels(controller.url)}
                    fieldRef={fieldRef}
                    fieldId="inbox-thread-message"
                    replaceMessageRef={replaceMessageRef}
                    pickReasons={pickReasons}
                    picksOffReason={isProjectPicked ? null : CHOOSE_PROJECT_FIRST}
                    aboveField={
                      <>
                        <ThingChips
                          things={draft.things.map((thing) => ({
                            id: thing.id,
                            pluginId: thing.source,
                            identifier: thing.identifier,
                            title: thing.title,
                          }))}
                          plugins={plugins}
                          onRemove={leaveThingOut}
                        />
                        {attempt !== undefined && !isStarting ? (
                          <button type="button" className="thread-dialog-retry" onClick={start}>
                            Try again
                          </button>
                        ) : null}
                        {lookupFailed ? (
                          <button
                            type="button"
                            className="thread-dialog-retry"
                            onClick={() => {
                              void match.refetch();
                            }}
                          >
                            Try the lookup again
                          </button>
                        ) : null}
                      </>
                    }
                    lipStart={
                      <ProjectPick
                        pick={projectPick}
                        reason={pickReason}
                        projects={projects.map((each) => ({
                          id: each.id,
                          name: each.name,
                          tint: pickProjectTint(each.id, projects),
                          repositories:
                            listProjectRepos(resources, each.id)
                              .map((repo) => formatRepoName(repo))
                              .join(", ") || "No repository",
                        }))}
                        openMenuRef={openProjectMenuRef}
                        onPick={chooseProject}
                      />
                    }
                    onSignIn={setSignIn}
                    onTextChange={writeText}
                    onChoose={choose}
                    onSubmit={start}
                    onOpenWorkspaceMenu={() => {
                      if (inspection.isPending) return;
                      const scope = controller.accountScopes.read();
                      for (const id of view.workspaceInspectionIds)
                        inspection.mutate({ id, scope });
                    }}
                  />
                ),
                onTitleChange: (title) => {
                  change({ title });
                },
                onPickStarter: pickStarter,
                onStart: start,
              }
            : {
                kind: "started",
                title: started.title,
                summary: started.summary,
                transcript: (
                  <Suspense fallback={null}>
                    <ThreadFirstMoments key={started.sessionId} sessionId={started.sessionId} />
                  </Suspense>
                ),
                note:
                  started.thingCount === 1
                    ? "It is on this Task now"
                    : `All ${String(started.thingCount)} are on this Task now`,
                onOpenThread: () => {
                  onOpenThread(started.sessionId);
                },
              }
        }
      />
      {signIn === null ? null : (
        // Without its own boundary, the dialog's load would suspend the dialog behind it.
        <Suspense fallback={null}>
          <ProviderLoginDialog
            client={client}
            providerAccountId={signIn.providerAccountId}
            runnerId={signIn.runnerId}
            // A failed start on the account and machine just signed in may have failed for the
            // missing sign-in, so the next start is the one to tell.
            onSignedIn={() => {
              if (
                signIn.providerAccountId === view.resolved.config.providerAccountId &&
                signIn.runnerId === view.fields.machine.runnerId
              ) {
                drafts.recordFailure(draftKey, null);
              }
            }}
            onClose={() => {
              setSignIn(null);
              fieldRef.current?.focus();
            }}
          />
        </Suspense>
      )}
    </>
  );
}

/**
 * Returns the line under the Task's name once the thread has started, such as
 * "Thread started · webshop · Opus 5.5 · High": the project (or "no project"),
 * the model, and the reasoning effort when the model has one.
 */
const describeStartedThread = (projectName: string | undefined, view: DraftView): string => {
  const { fields, resolved } = view;
  const effort =
    fields.options === null ? null : buildOptionsLabel(fields.options, resolved.config.options);
  return [
    "Thread started",
    projectName ?? "no project",
    fields.model.pill.name ?? "default model",
    ...(effort === null ? [] : [effort]),
  ].join(" · ");
};
