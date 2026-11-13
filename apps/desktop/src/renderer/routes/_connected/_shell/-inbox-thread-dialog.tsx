import { lazy, Suspense, useRef, useState, useSyncExternalStore, type JSX } from "react";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  applyThreadChoice,
  buildComposerPlaceholder,
  buildDraftView,
  buildOptionsLabel,
  buildRecentModel,
  buildSubmission,
  formatAccessMode,
  formatRepoName,
  holdsMessageContent,
  joinPhraseText,
  listProjectRepos,
  queryKeys,
  readErrorMessage,
  type RecentModel,
  type SignInTarget,
  type ShelfItem,
  type ThreadChoice,
  type ThreadPicks,
} from "@hercule/client-core";
import {
  THREAD_STARTERS,
  buildPicksForProjectChoice,
  buildPicksUnderChoice,
  buildThingsPromptText,
  decideEvidenceWorkspacePick,
  describePickReason,
  describeProjectChoice,
  hasProjectPick,
  writeStarterMessage,
  type ProjectChoice,
  type ThreadStarter,
} from "@hercule/client-core/inbox";
import type { InboxThing, SessionSpawnInput, Workspace } from "@hercule/contract";
import { useDraftReads } from "../../../app/draft-thread";
import { pluginsQuery, projectMatchQuery } from "../../../app/queries";
import { readReason } from "../../../app/read-reason";
import { readRecentModels } from "../../../app/recent-models";
import type { ThreadStartDraft, ThreadStartDrafts } from "../../../app/thread-start-drafts";
import { buildLook } from "../../../faces";
import { useComposerImages } from "../../../screens/attachments/use-composer-images";
import { DraftComposer } from "../../../screens/new-thread/draft-composer";
import { useDraftSkills } from "../../../screens/new-thread/use-draft-skills";
import { pickProjectTint } from "../../../screens/project-tile";
import { useSendOnMenuCommand } from "../../../screens/session/send-key";
import { ThreadDialog } from "../../../screens/inbox/thread-dialog";
import { ThingChips } from "../../../screens/inbox/thread-dialog-chips";
import {
  ProjectPick,
  type ProjectPickValue,
} from "../../../screens/inbox/thread-dialog-project-pick";
import { ThreadFirstMoments } from "../../../screens/thread/thread-first-moments";

// The sign-in dialog is loaded the first time Sign in opens it (spec 17 §Performance).
const ProviderLoginDialog = lazy(() =>
  import("../../../screens/provider-login").then((module) => ({
    default: module.ProviderLoginDialog,
  })),
);

/** The shelf key of the images a dialog holds, in the pending submissions. */
export const buildThreadStartImagesKey = (draftKey: string): string => `inbox-thread:${draftKey}`;

/** What one send carries to the controller, and what the screen needs once it answers. */
export interface SentThread {
  /** The key of the draft the send was made from. */
  readonly draftKey: string;
  readonly input: SessionSpawnInput;
  /** The new Task's name. */
  readonly title: string;
  readonly things: readonly InboxThing[];
  /** The images the send carries, which leave the shelf once it succeeds. */
  readonly attachments: readonly ShelfItem[];
  /** The model the user picked for this send, to remember in Recent once it succeeds, or `null`. */
  readonly recent: RecentModel | null;
  /** The line under the Task's name once the thread has started. */
  readonly summary: string;
}

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
    mutationFn: (id: string) => client.workspace.inspect({ params: { id } }),
    onSuccess: (current) => {
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
  const choice: ProjectChoice =
    draft.chosenProject === null
      ? { kind: "none-chosen" }
      : draft.chosenProject !== undefined
        ? { kind: "chosen", projectId: draft.chosenProject }
        : match.data !== undefined
          ? { kind: "inferred", match: match.data }
          : match.isError
            ? { kind: "failed", reason: readReason(match.error) }
            : { kind: "matching" };
  const matchedResourceId =
    choice.kind === "inferred" && choice.match.kind === "matched"
      ? choice.match.resourceId
      : undefined;
  const projectId =
    choice.kind === "chosen"
      ? choice.projectId
      : choice.kind === "inferred" && choice.match.kind === "matched"
        ? choice.match.projectId
        : null;
  // "No project" is a choice too: the thread then starts with no checkout.
  const isProjectPicked = hasProjectPick(choice) || choice.kind === "none-chosen";
  const underChoice = buildPicksUnderChoice(draft.picks, choice.kind === "none-chosen");
  // The workspace follows the repository the match found its evidence in, unless the user picked one.
  const picks: ThreadPicks =
    matchedResourceId === undefined || underChoice.workspace !== undefined
      ? underChoice
      : {
          ...underChoice,
          workspace: decideEvidenceWorkspacePick(
            listProjectRepos(reads.resources, projectId),
            matchedResourceId,
            reads.settings.user["thread.workspace"] ?? null,
          ),
        };
  const view = buildDraftView(reads, { projectId, workspaceId: null }, picks);
  const { projects, resources, workspaces } = view.catalogs;
  const project = projects.find((each) => each.id === projectId);
  const resource = resources.find((each) => each.id === matchedResourceId);
  const names = {
    ...(project === undefined ? {} : { projectName: project.name }),
    ...(resource === undefined ? {} : { repositoryName: formatRepoName(resource) }),
    hasModelProfile: project?.modelProfileId != null,
    asksBeforeEdits: view.fields.accessMode.value === "approval-required",
  };

  const images = useComposerImages({
    storeKey: imagesKey,
    shelf,
    imageInput: view.fields.model.imageInput,
    modelName: view.fields.model.modelName,
    readOnly: false,
  });
  const skills = useDraftSkills(view);
  const { blocked } = view.fields;
  // The message is the user's own words or an image: the things are added to it when it is sent.
  const hasMessage = holdsMessageContent({ text: draft.text, attachments: shelf });
  const canSend =
    isProjectPicked && hasMessage && blocked === null && !isStarting && !images.sendBlocked;

  /** Returns the draft as it is now, which a handler reads instead of the render it was made in. */
  const readLatest = (): ThreadStartDraft => drafts.read(draftKey) ?? draft;
  /**
   * Writes `patch` to the draft, which the user changed. The draft is no longer the one a send was
   * made from, so its dedup key goes; `clearsFailure` also removes the failed
   * send's message, for a change that answers it.
   */
  const change = (patch: Partial<ThreadStartDraft>, clearsFailure = false): void => {
    drafts.write(draftKey, {
      ...readLatest(),
      ...patch,
      dedupKey: undefined,
      isEdited: true,
      ...(clearsFailure ? { failure: null } : {}),
    });
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
    // The reason line says the match is on its way, and the send follows the answer.
    if (choice.kind === "matching") return;
    if (!isProjectPicked) {
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
    const prompt = buildThingsPromptText(current.text, current.things);
    if (prompt.kind === "too-long") {
      setRefusal(prompt.reason);
      return;
    }
    const dedupKey = current.dedupKey ?? crypto.randomUUID();
    if (current.dedupKey === undefined) drafts.write(draftKey, { ...current, dedupKey });
    images.clearRefusal();
    const { input } = buildSubmission(view.resolved, { text: prompt.text, attachments: shelf });
    onSend({
      draftKey,
      input: {
        ...input,
        newTask: { title, entityIds: current.things.map((thing) => thing.id) },
        dedupKey,
      },
      title,
      things: current.things,
      attachments: shelf,
      recent: buildRecentModel(current.picks, view.resolved),
      summary: describeStartedThread(project?.name, view),
    });
  };
  useSendOnMenuCommand(start);

  const pickValue: ProjectPickValue =
    choice.kind === "none-chosen"
      ? { kind: "none" }
      : projectId !== null
        ? { kind: "project", projectId }
        : { kind: "unpicked" };
  const reasonLabels = {
    ...names,
    accessLabel: formatAccessMode(view.fields.accessMode.value),
    profileLabel: view.fields.model.pill.name ?? "",
  };
  // A match that is on its way or failed is not "nothing points at a repository", which the pick's own reason says.
  const pickReason =
    choice.kind === "matching" || choice.kind === "failed"
      ? describeProjectChoice(choice, names)
          .map((part) => part.text)
          .join("")
      : describePickReason("project", choice, reasonLabels);
  const pickReasons = {
    accessMode: describePickReason("access", choice, reasonLabels),
    model: describePickReason("profile", choice, reasonLabels),
    workspace: joinPhraseText(view.fields.lead ?? []),
  };
  const error =
    refusal ??
    draft.failure ??
    (inspection.error === null ? null : readErrorMessage(inspection.error)) ??
    (blocked === null ? null : `Can’t start yet. ${blocked.reason}.`);

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
                reason: describeProjectChoice(choice, names),
                composer: (
                  <DraftComposer
                    view={view}
                    text={draft.text}
                    placeholder={buildComposerPlaceholder({
                      readOnly: null,
                      busy: false,
                      active: false,
                      pick: view.fields.workspace.value,
                      workspaces,
                    })}
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
                    runnerId={view.resolved.menuRunnerId}
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
                        {choice.kind === "failed" ? (
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
                        pick={pickValue}
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
                      for (const id of view.workspaceInspectionIds) inspection.mutate(id);
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
                drafts.write(draftKey, { ...readLatest(), failure: null });
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
const describeStartedThread = (
  projectName: string | undefined,
  view: ReturnType<typeof buildDraftView>,
): string => {
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
