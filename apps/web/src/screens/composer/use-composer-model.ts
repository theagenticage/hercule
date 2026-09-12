import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  applyPick,
  pushRecent,
  queryKeys,
  resumeBlockedReason,
  submission,
  type ComposerPick,
  type HydraClient,
  type RecentModel,
  type Thread,
  type ThreadCatalogs,
  type ThreadConfig,
  type ThreadKind,
  type ThreadPicks,
} from "@hydra/client-core";
import type { Session, SessionInputPayload, SessionSpawnInput } from "@hydra/contract";

/** Where the last models picked are kept; nothing on the API carries them. */
const RECENT_KEY = "hydra.recentModels";

/** A browser with no usable store loses Recent and nothing else. */
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
    // A convenience; losing it is not worth a word to anyone.
  }
};
/** What an active thread runs with, in the shape a draft's defaults have. */
const sessionConfig = (session: Session): ThreadConfig => ({
  instanceId: session.instanceId,
  model: session.modelSelection.model,
  options: session.modelSelection.options,
  accessMode: session.accessMode,
  runnerId: session.runnerId,
  profileId: session.permissionProfileId,
});

export interface ComposerModel {
  readonly kind: ThreadKind;
  readonly config: ThreadConfig;
  readonly picks: ThreadPicks;
  readonly recent: readonly RecentModel[];
  readonly message: string;
  readonly placeholder: string;
  readonly sendTip: string;
  /** The sentence a draft stands under; a started thread has none. */
  readonly lead: string | null;
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
 * The one place a draft thread and an active one differ. A draft holds no
 * configuration of its own: its defaults are recomputed every render and the
 * picks lie over them, so a catalog arriving late - a login landing while the
 * draft is open - fills what the user has not picked. Below this hook nothing
 * knows which of the two it is drawing.
 */
export function useComposerModel(
  thread: Thread,
  catalogs: ThreadCatalogs,
  client: HydraClient,
  onSend?: () => void,
): ComposerModel {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [message, setMessage] = useState("");
  const [picks, setPicks] = useState<ThreadPicks>({});
  const [recent, setRecent] = useState(readRecent);

  const { session, base } =
    thread.kind === "draft"
      ? { session: null, base: thread.config }
      : { session: thread.session, base: sessionConfig(thread.session) };

  // The per-model choices belong to the model that offered them: while the
  // model on show is the one the thread runs, the picks sit over what it
  // stored; another model shows its own defaults instead.
  const configOf = (held: ThreadPicks): ThreadConfig => {
    const model = held.model ?? base.model;
    return {
      ...base,
      ...held,
      model,
      options: model === base.model ? { ...base.options, ...held.options } : { ...held.options },
    };
  };
  const config = configOf(picks);
  // Recent follows the submission home, and holds only what was picked.
  const remember = (): void => {
    const model = picks.model ?? null;
    if (model === null || config.instanceId === null) return;
    const next = pushRecent(recent, { instanceId: config.instanceId, model });
    setRecent(next);
    writeRecent(next);
  };
  const spawn = useMutation({
    mutationFn: (payload: SessionSpawnInput) => client.session.spawn({ payload }),
    onSuccess: (created) => {
      remember();
      void navigate({ to: "/threads/$sessionId", params: { sessionId: created.id } });
    },
  });
  const input = useMutation({
    mutationFn: (sent: { readonly id: string; readonly payload: SessionInputPayload }) =>
      client.session.input({ params: { id: sent.id }, payload: sent.payload }),
    onSuccess: async (_answer, sent) => {
      remember();
      // The picks are cleared only once the row that holds them is in the cache.
      await queryClient.invalidateQueries({ queryKey: queryKeys.session(sent.id) });
      setMessage("");
      setPicks({});
      void queryClient.invalidateQueries({ queryKey: queryKeys.inputs(sent.id) });
      onSend?.();
    },
  });
  const interrupt = useMutation({
    mutationFn: (id: string) => client.session.interrupt({ params: { id } }),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.session(updated.id), updated);
    },
  });
  const readOnly = session === null ? null : resumeBlockedReason(session);
  const busy = session?.status === "busy";

  return {
    kind: thread.kind,
    config,
    picks,
    recent,
    message,
    placeholder:
      readOnly !== null
        ? `This thread can't be resumed: ${readOnly}.`
        : busy
          ? "Queued until the turn finishes…"
          : session === null
            ? "Say what you want done…"
            : "Reply…",
    sendTip: session === null ? "Start thread ⏎" : "Send ⏎",
    lead: session === null ? "It works without a checkout." : null,
    readOnly,
    busy,
    sending: spawn.isPending || input.isPending,
    error: spawn.error ?? input.error ?? interrupt.error,
    setMessage,
    // Folded against the thread's own configuration, never against the picks
    // already made, so a pick landing back on it is not a pick at all.
    pick: (...steps) => {
      setPicks((held) => steps.reduce((acc, step) => applyPick(base, acc, step, catalogs), held));
    },
    submit: () => {
      const payload = submission(thread, picks, { text: message });
      if ("prompt" in payload) spawn.mutate(payload);
      else if (session !== null) input.mutate({ id: session.id, payload });
    },
    stop: () => {
      if (session !== null) interrupt.mutate(session.id);
    },
  };
}
