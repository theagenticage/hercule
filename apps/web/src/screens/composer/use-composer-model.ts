import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  addFilesToShelf,
  addWorkspacePicks,
  applyPicks,
  buildComposerFields,
  buildComposerPlaceholder,
  buildRecentModel,
  computeEffectiveConfig,
  applyUploadOutcome,
  describeSendBlock,
  findExpiredShelfKeys,
  markShelfItemsExpired,
  markShelfItemUploading,
  parseRecentModels,
  pushRecent,
  queryKeys,
  findResumeBlockedReason,
  buildSubmission,
  readThreadConfig,
  removeShelfItem,
  type ComposerFields,
  type ComposerPick,
  type HerculeClient,
  type ImageFile,
  type MessageDraft,
  type RecentModel,
  type ShelfItem,
  type Thread,
  type ThreadCatalogs,
  type ThreadConfig,
  type ThreadKind,
  type ThreadPicks,
  type UploadQueue,
} from "@hercule/client-core";
import type { SessionInputPayload, SessionSpawnInput } from "@hercule/contract";
import { useComposerDraft } from "../../app/thread-drafts";
import { useStopAgent } from "../use-stop-agent";

/** The localStorage key for the recently picked models. The API does not store them. */
const RECENT_KEY = "hercule.recentModels";

/**
 * Returns the recently picked models from localStorage, or an empty list when
 * storage is unavailable or holds something unreadable. Without storage, only
 * the Recent lane is lost.
 */
const readRecent = (): readonly RecentModel[] => {
  try {
    return parseRecentModels(window.localStorage.getItem(RECENT_KEY));
  } catch {
    return [];
  }
};
const writeRecent = (recent: readonly RecentModel[]): void => {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch {
    // Recent is only a convenience, so a failed write is ignored silently.
  }
};
export interface ComposerModel {
  readonly kind: ThreadKind;
  readonly config: ThreadConfig;
  /** Every lock, blocker and resolved pick the composer renders. */
  readonly fields: ComposerFields;
  readonly picks: ThreadPicks;
  readonly recent: readonly RecentModel[];
  /** The unsent text and the images on the shelf. */
  readonly message: MessageDraft;
  /**
   * Why the images stop the message from being sent, such as an upload still
   * running or a model that does not accept images; `null` when they do not.
   */
  readonly attachmentBlock: string | null;
  /** Why the files last attached were left off the shelf; `null` once a later attach or send succeeds. */
  readonly refusal: string | null;
  readonly placeholder: string;
  readonly sendTip: string;
  /** Why the thread can take no input at all; null when it can. */
  readonly readOnly: string | null;
  readonly busy: boolean;
  readonly sending: boolean;
  readonly error: Error | null;
  readonly setMessage: (text: string) => void;
  /** Adds images to the shelf and starts their uploads. */
  readonly attachFiles: (files: readonly ImageFile[]) => void;
  readonly removeAttachment: (key: string) => void;
  readonly retryAttachment: (key: string) => void;
  readonly pick: (...steps: readonly ComposerPick[]) => void;
  readonly submit: () => void;
  readonly stop: () => void;
}

/**
 * Returns the composer's state and actions for a draft or an active thread.
 * This hook is the only place that handles the difference between the two;
 * the components below it do not know which kind they render.
 *
 * A draft stores no configuration of its own. Its defaults are recomputed on
 * every render and the user's picks are applied on top. So a catalog that
 * arrives late, such as after a login while the draft is open, fills in
 * whatever the user has not picked.
 *
 * The unsent message, its images and the picks are the thread's drafts, so
 * they survive a visit to one of the thread's subagents. An image's upload
 * starts as soon as it is attached, in the app's `uploads` queue; its result
 * goes into the draft even when the composer has unmounted in the meantime.
 * An uploaded image's bytes go into the query cache as its content, so the
 * sent message shows it without downloading it again.
 */
export function useComposerModel(
  thread: Thread,
  catalogs: ThreadCatalogs,
  client: HerculeClient,
  uploads: UploadQueue,
  onSend?: () => void,
): ComposerModel {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [{ message, picks }, changeDraft] = useComposerDraft();
  const [recent, setRecent] = useState(readRecent);
  const [refusal, setRefusal] = useState<string | null>(null);
  const changeShelf = (change: (shelf: readonly ShelfItem[]) => readonly ShelfItem[]): void => {
    changeDraft((draft) => ({
      ...draft,
      message: { ...draft.message, attachments: change(draft.message.attachments) },
    }));
  };
  const startUpload = (item: ShelfItem): void => {
    void uploads.add(item.key, item.file).then((outcome) => {
      if (outcome.status === "cancelled") return;
      if (outcome.status === "uploaded")
        queryClient.setQueryData(queryKeys.attachmentContent(outcome.attachment.id), item.file);
      changeShelf((shelf) => applyUploadOutcome(shelf, item.key, outcome));
    });
  };
  // A sent message leaves the shelf, except images attached while it was in
  // flight, which belong to the next message. An image that expired is marked
  // on its tile, so the user knows which one to attach again.
  const clearSentShelf = (sent: readonly ShelfItem[]): void => {
    const sentKeys = new Set(sent.map((item) => item.key));
    changeShelf((shelf) => shelf.filter((item) => !sentKeys.has(item.key)));
    setRefusal(null);
  };
  const markExpiredImages = (error: unknown, sent: readonly ShelfItem[]): void => {
    const expired = findExpiredShelfKeys(error, sent);
    if (expired.length > 0) changeShelf((shelf) => markShelfItemsExpired(shelf, expired));
  };

  const session = thread.kind === "active" ? thread.session : null;
  const base = readThreadConfig(thread);
  const config = computeEffectiveConfig(base, picks);
  const fields = buildComposerFields(catalogs, config, thread.kind);
  // Recent is updated only after a successful send.
  const rememberRecentModel = (): void => {
    const pair = buildRecentModel(picks, config.instanceId);
    if (pair === null) return;
    const next = pushRecent(recent, pair);
    setRecent(next);
    writeRecent(next);
  };
  // Set by `submit` before it calls `mutate`, and cleared when the send
  // settles. `isPending` reaches the render a tick after `mutate`, so a second
  // Enter in the same tick would still see it false; the ref is set at once.
  const sendingRef = useRef(false);
  const releaseSend = (): void => {
    sendingRef.current = false;
  };
  const spawn = useMutation({
    mutationFn: (sent: {
      readonly payload: SessionSpawnInput;
      readonly shelf: readonly ShelfItem[];
    }) => client.session.spawn({ payload: sent.payload }),
    onSuccess: (created, sent) => {
      rememberRecentModel();
      clearSentShelf(sent.shelf);
      void navigate({ to: "/threads/$sessionId", params: { sessionId: created.id } });
    },
    onError: (error, sent) => {
      markExpiredImages(error, sent.shelf);
    },
    onSettled: releaseSend,
  });
  const input = useMutation({
    mutationFn: (sent: {
      readonly id: string;
      readonly payload: SessionInputPayload;
      readonly shelf: readonly ShelfItem[];
    }) => client.session.input({ params: { id: sent.id }, payload: sent.payload }),
    onSuccess: async (_answer, sent) => {
      rememberRecentModel();
      // Clear the picks only after the updated session is in the cache, so the
      // composer never falls back to the old configuration in between.
      await queryClient.invalidateQueries({ queryKey: queryKeys.session(sent.id) });
      // Text typed while the message was in flight is a new message, so the
      // box is cleared only while it still holds what was sent.
      changeDraft((draft) => ({
        message: {
          ...draft.message,
          text: draft.message.text === sent.payload.text ? "" : draft.message.text,
        },
        picks: {},
      }));
      clearSentShelf(sent.shelf);
      void queryClient.invalidateQueries({ queryKey: queryKeys.inputs(sent.id) });
      onSend?.();
    },
    onError: (error, sent) => {
      markExpiredImages(error, sent.shelf);
    },
    onSettled: releaseSend,
  });
  const stopAgent = useStopAgent(client, session?.id ?? null);
  const readOnly = session === null ? null : findResumeBlockedReason(session);
  const busy = session?.status === "busy";

  return {
    kind: thread.kind,
    config,
    fields,
    picks,
    recent,
    message,
    attachmentBlock: describeSendBlock(message.attachments, fields.model),
    refusal,
    placeholder: buildComposerPlaceholder({
      readOnly,
      busy,
      active: session !== null,
      pick: fields.workspace.value,
      workspaces: catalogs.workspaces ?? [],
    }),
    sendTip: session === null ? "Start thread ⏎" : "Send ⏎",
    readOnly,
    busy,
    sending: spawn.isPending || input.isPending,
    error: spawn.error ?? input.error ?? stopAgent.error,
    setMessage: (text) => {
      changeDraft((draft) => ({ ...draft, message: { ...draft.message, text } }));
    },
    attachFiles: (files) => {
      // The shelf hands out each image's key as it adds it, so the images are
      // added once here, against the shelf this render holds, and not inside
      // the draft update, which React may run twice.
      const added = addFilesToShelf(message.attachments, files, fields.model);
      const fresh = added.shelf.slice(message.attachments.length);
      setRefusal(added.refusals.length === 0 ? null : added.refusals.join(" "));
      if (fresh.length === 0) return;
      changeShelf((shelf) => [...shelf, ...fresh]);
      fresh.forEach(startUpload);
    },
    removeAttachment: (key) => {
      uploads.cancel(key);
      changeShelf((shelf) => removeShelfItem(shelf, key));
    },
    retryAttachment: (key) => {
      const item = message.attachments.find((candidate) => candidate.key === key);
      if (item === undefined) return;
      changeShelf((shelf) => markShelfItemUploading(shelf, key));
      startUpload(item);
    },
    // Each pick is compared with the thread's own configuration, not with
    // earlier picks, so picking the configured value again clears the pick.
    pick: (...steps) => {
      changeDraft((draft) => ({
        ...draft,
        picks: applyPicks(catalogs, base, draft.picks, steps),
      }));
    },
    submit: () => {
      // A second Enter or click before the first send settles is ignored, so
      // one message is never sent twice.
      if (sendingRef.current || spawn.isPending || input.isPending) return;
      const sent = buildSubmission(
        thread,
        thread.kind === "draft"
          ? addWorkspacePicks(picks, fields.workspace.value, catalogs.workspaces ?? [])
          : picks,
        message,
      );
      sendingRef.current = true;
      const shelf = message.attachments;
      switch (sent.kind) {
        case "spawn":
          return spawn.mutate({ payload: sent.input, shelf });
        case "input":
          return input.mutate({ id: sent.sessionId, payload: sent.payload, shelf });
      }
    },
    stop: () => {
      stopAgent.stop();
    },
  };
}
