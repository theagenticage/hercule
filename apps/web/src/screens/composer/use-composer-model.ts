import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  applyPick,
  buildComposerFields,
  buildComposerPlaceholder,
  computeEffectiveConfig,
  pushRecent,
  queryKeys,
  findResumeBlockedReason,
  findRunnerForPick,
  buildSubmission,
  readThreadConfig,
  type ComposerFields,
  type ComposerPick,
  type HerculeClient,
  type RecentModel,
  type Thread,
  type ThreadCatalogs,
  type ThreadConfig,
  type ThreadKind,
  type ThreadPicks,
} from "@hercule/client-core";
import type { SessionInputPayload, SessionSpawnInput } from "@hercule/contract";

/** The localStorage key for the recently picked models. The API does not store them. */
const RECENT_KEY = "hercule.recentModels";

/**
 * Returns the recently picked models from localStorage, or an empty list when
 * storage is unavailable or holds something unreadable. Without storage, only
 * the Recent lane is lost.
 */
const readRecent = (): readonly RecentModel[] => {
  try {
    const held: unknown = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(held) ? (held as readonly RecentModel[]) : [];
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
  readonly message: string;
  readonly placeholder: string;
  readonly sendTip: string;
  /** Why the thread can take no input at all; null when it can. */
  readonly readOnly: string | null;
  readonly busy: boolean;
  readonly sending: boolean;
  readonly error: Error | null;
  readonly setMessage: (text: string) => void;
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
 */
export function useComposerModel(
  thread: Thread,
  catalogs: ThreadCatalogs,
  client: HerculeClient,
  onSend?: () => void,
): ComposerModel {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [message, setMessage] = useState("");
  const [picks, setPicks] = useState<ThreadPicks>({});
  const [recent, setRecent] = useState(readRecent);

  const session = thread.kind === "active" ? thread.session : null;
  const base = readThreadConfig(thread);
  const config = computeEffectiveConfig(base, picks);
  const fields = buildComposerFields(catalogs, config, thread.kind);
  // Recent is updated only after a successful send, and records only a model
  // the user picked, not a default.
  const rememberRecentModel = (): void => {
    const model = picks.model ?? null;
    if (model === null || config.instanceId === null) return;
    const next = pushRecent(recent, { instanceId: config.instanceId, model });
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
    mutationFn: (payload: SessionSpawnInput) => client.session.spawn({ payload }),
    onSuccess: (created) => {
      rememberRecentModel();
      void navigate({ to: "/threads/$sessionId", params: { sessionId: created.id } });
    },
    onSettled: releaseSend,
  });
  const input = useMutation({
    mutationFn: (sent: { readonly id: string; readonly payload: SessionInputPayload }) =>
      client.session.input({ params: { id: sent.id }, payload: sent.payload }),
    onSuccess: async (_answer, sent) => {
      rememberRecentModel();
      // Clear the picks only after the updated session is in the cache, so the
      // composer never falls back to the old configuration in between.
      await queryClient.invalidateQueries({ queryKey: queryKeys.session(sent.id) });
      // Text typed while the message was in flight is a new message, so the
      // box is cleared only while it still holds what was sent.
      setMessage((current) => (current === sent.payload.text ? "" : current));
      setPicks({});
      void queryClient.invalidateQueries({ queryKey: queryKeys.inputs(sent.id) });
      onSend?.();
    },
    onSettled: releaseSend,
  });
  const interrupt = useMutation({
    mutationFn: (id: string) => client.session.interrupt({ params: { id } }),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.session(updated.id), updated);
    },
  });
  const readOnly = session === null ? null : findResumeBlockedReason(session);
  const busy = session?.status === "busy";

  return {
    kind: thread.kind,
    config,
    fields,
    picks,
    recent,
    message,
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
    error: spawn.error ?? input.error ?? interrupt.error,
    setMessage,
    // Each pick is compared with the thread's own configuration, not with
    // earlier picks, so picking the configured value again clears the pick.
    pick: (...steps) => {
      setPicks((held) => steps.reduce((acc, step) => applyPick(catalogs, base, acc, step), held));
    },
    submit: () => {
      // A second Enter or click before the first send settles is ignored, so
      // one message is never sent twice.
      if (sendingRef.current || spawn.isPending || input.isPending) return;
      // A draft is spawned with the workspace the composer resolved, even when
      // it is the default the user never touched. An existing workspace also
      // fixes the machine.
      const workspace = fields.workspace.value;
      const settled = findRunnerForPick(workspace, catalogs.workspaces ?? []);
      const sent = buildSubmission(
        thread,
        thread.kind === "draft"
          ? { ...picks, workspace, ...(settled === null ? {} : { runnerId: settled }) }
          : picks,
        { text: message },
      );
      sendingRef.current = true;
      switch (sent.kind) {
        case "spawn":
          return spawn.mutate(sent.input);
        case "input":
          return input.mutate({ id: sent.sessionId, payload: sent.payload });
      }
    },
    stop: () => {
      if (session !== null) interrupt.mutate(session.id);
    },
  };
}
