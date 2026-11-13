import { Suspense, useRef, useState, useSyncExternalStore, type JSX } from "react";
import { keepPreviousData, useQuery, useSuspenseQuery } from "@tanstack/react-query";
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
  listProjectRepos,
  type RecentModel,
  type ShelfItem,
  type ThreadChoice,
  type ThreadPicks,
} from "@hercule/client-core";
import {
  THREAD_STARTERS,
  buildThingsPromptText,
  describePickReason,
  describeProjectChoice,
  hasProjectPick,
  writeStarterMessage,
  type ProjectChoice,
  type ReasonPhrase,
  type ThreadStarter,
} from "@hercule/client-core/inbox";
import type { InboxThing, SessionSpawnInput } from "@hercule/contract";
import { useDraftReads } from "../../../app/draft-thread";
import { pluginsQuery, projectMatchQuery } from "../../../app/queries";
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

/** What the project pick says while the controller is still matching the things to a project. */
const MATCHING_WORDS: readonly ReasonPhrase[] = [
  { text: "Looking for the project these belong to." },
];

/** Why the composer's picks wait for a project. */
const CHOOSE_PROJECT_FIRST = "Choose a project first";

/** Returns `picks` without the workspace pick, which belongs to the project it was made in. */
const dropWorkspacePick = (picks: ThreadPicks): ThreadPicks => {
  const kept = { ...picks };
  delete kept.workspace;
  return kept;
};

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
    // A chip that leaves reads the match again, and the project stays until the new answer.
    placeholderData: keepPreviousData,
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

  const choice: ProjectChoice =
    draft.chosenProject === null
      ? { kind: "none-chosen" }
      : draft.chosenProject !== undefined
        ? { kind: "chosen", projectId: draft.chosenProject }
        : match.data !== undefined
          ? { kind: "inferred", match: match.data }
          : match.isError
            ? { kind: "inferred", match: { kind: "none" } }
            : { kind: "unpicked" };
  const isMatching =
    draft.chosenProject === undefined && match.data === undefined && !match.isError;
  const projectId =
    choice.kind === "chosen"
      ? choice.projectId
      : choice.kind === "inferred" && choice.match.kind === "matched"
        ? choice.match.projectId
        : null;
  // "No project" is a choice too: the thread then starts with no checkout.
  const isProjectPicked = hasProjectPick(choice) || choice.kind === "none-chosen";
  const picks: ThreadPicks =
    choice.kind === "none-chosen"
      ? { accessMode: "approval-required", ...draft.picks }
      : draft.picks;
  const view = buildDraftView(reads, { projectId, workspaceId: null }, picks);
  const { projects, resources, workspaces } = view.catalogs;
  const project = projects.find((each) => each.id === projectId);
  const matchedResourceId =
    choice.kind === "inferred" && choice.match.kind === "matched"
      ? choice.match.resourceId
      : undefined;
  const resource = resources.find((each) => each.id === matchedResourceId);
  const names = {
    ...(project === undefined ? {} : { projectName: project.name }),
    ...(resource === undefined ? {} : { repositoryName: formatRepoName(resource) }),
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
  const canSend = isProjectPicked && blocked === null && !isStarting && !images.sendBlocked;

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
    const current = readLatest();
    change({ chosenProject: id, picks: dropWorkspacePick(current.picks) }, true);
  };
  const choose = (picked: ThreadChoice): void => {
    change({ picks: applyThreadChoice(readLatest().picks, picked) }, true);
  };

  const start = (): void => {
    if (started !== null) return;
    if (isMatching) return;
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
  const pickReason = describePickReason("project", choice, {
    ...names,
    accessLabel: formatAccessMode(view.fields.accessMode.value),
    profileLabel: view.fields.model.pill.name ?? "",
  });
  const error =
    refusal ?? draft.failure ?? (blocked === null ? null : `Can’t start yet. ${blocked.reason}.`);

  return (
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
              reason: isMatching ? MATCHING_WORDS : describeProjectChoice(choice, names),
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
                      if (pendingSubmissions.read(imagesKey).message.attachments.length > before) {
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
                  picksOffReason={isProjectPicked ? null : CHOOSE_PROJECT_FIRST}
                  aboveField={
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
                  onSignIn={() => undefined}
                  onTextChange={writeText}
                  onChoose={choose}
                  onSubmit={start}
                  onOpenWorkspaceMenu={() => undefined}
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
