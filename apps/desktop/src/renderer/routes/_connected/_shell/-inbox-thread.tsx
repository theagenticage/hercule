/**
 * The Inbox's start-thread dialog: N, a row's button and the pane's button
 * open it on the things the move is for, and sending it makes one new Task
 * from those things and a thread on it (`session.spawn` with `newTask`).
 *
 * - What the user writes is kept per set of things (`AccountScope.threadStarts`),
 *   so closing the dialog unsent and pressing N on the same things opens the
 *   words again. A dialog closed without a change keeps nothing.
 * - A draft that was sent, or failed, is kept even with no change: the
 *   controller may have made the thread while the answer was lost, and N then
 *   reopens it (also when its things show as held by that thread's Task) so a
 *   retry finds the thread again by its dedup key.
 * - A thread that started is not undone: the undo line says so with an "Open
 *   it" button, and nothing goes on the undo stack.
 * - Every continuation of a request first asks the account scope that the user
 *   is still the one signed in.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { isMutationRunning, queryKeys } from "@hercule/client-core";
import {
  REFUSED_OFFLINE,
  buildThingsDraftKey,
  describeThreadStartError,
} from "@hercule/client-core/inbox";
import type { SavedController } from "../../../app/context";
import { requireSignedIn, type AccountScope } from "../../../app/account-scope";
import {
  ensureThreadData,
  profilesQuery,
  settingsQuery,
  threadAndAgentSessionsQuery,
} from "../../../app/queries";
import { readReason } from "../../../app/read-reason";
import { rememberRecentModel } from "../../../app/recent-models";
import type { SentThread, ThreadStartDrafts } from "../../../app/thread-start-drafts";
import type { InboxMoves } from "./-inbox-moves";
import {
  InboxThreadDialog,
  buildThreadStartImagesKey,
  type StartedThread,
} from "./-inbox-thread-dialog";
import type { InboxListSnapshot, InboxListVisit } from "./-inbox-visit";

/** The key every start of a thread runs under, so a second press while one is on its way sends nothing. */
const START_KEY = ["inbox-thread-start"];

/** Loads the transcript's code, which the Inbox's chunk leaves out until a thread has started. */
const loadThreadFirstMoments = (): Promise<unknown> =>
  import("../../../screens/thread/thread-first-moments");

const WORDS_KEPT = "Your words are kept. N on the same things opens them again.";

/** What `useInboxThread` returns. It changes only when the dialog opens, closes, sends or starts. */
export interface InboxThread {
  /**
   * Opens the dialog on the things the move is for: a group, the selection,
   * else the current row, or with `hoveredKey` that line (see
   * `InboxMoves.dismiss`), with the default name its plan gives. A
   * refusal says why on the undo line and opens nothing. The dialog waits for
   * the settings and profiles it reads, so it opens a moment after the call.
   * The function is the same for the life of the screen.
   */
  readonly open: (hoveredKey?: string) => void;
  /** The dialog while it is open, else `null`: the screen draws it with its overlays. */
  readonly element: JSX.Element | null;
}

/**
 * Returns whether a stored draft holds a send that was attempted, which may
 * have made the thread: its things can then show as held by its own Task.
 */
const hasAttemptedSend = (
  drafts: ThreadStartDrafts,
  things: readonly { readonly id: string }[],
): boolean =>
  drafts.read(buildThingsDraftKey(things.map((thing) => thing.id)))?.attempt !== undefined;

/**
 * Makes the start-thread dialog of the Inbox for `controller`, over the list
 * `visit` holds, with the undo line and the refusals of `moves`. `onClosed`
 * is called with the list as it is when the dialog closes, and again when the
 * list empties after the thread's things left it, so the screen can put the
 * focus on the current row or on the empty state: the page behind a modal
 * dialog cannot take the focus while it is open.
 *
 * The hook never reads the draft: the dialog does, so typing in it renders the
 * dialog alone and not the Inbox screen.
 */
export function useInboxThread({
  controller,
  scope,
  visit,
  moves,
  isOffline,
  onClosed,
}: {
  readonly controller: SavedController;
  readonly scope: AccountScope;
  readonly visit: InboxListVisit;
  readonly moves: InboxMoves;
  /** Whether the Inbox shows itself offline: the one state that decides whether a send is refused. */
  readonly isOffline: boolean;
  readonly onClosed: (snapshot: InboxListSnapshot) => void;
}): InboxThread {
  const { client, pendingSubmissions } = controller;
  const { threadStarts: drafts } = scope;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [started, setStarted] = useState<StartedThread | null>(null);
  const isOpening = useRef(false);
  // The refs of the things a started thread took, while the list may still drop them.
  const taken = useRef<readonly string[] | null>(null);

  // A continuation of a request outlives the render that made it, so it reads the newest of these.
  const latest = useRef({ openKey, started, moves, isOffline, onClosed, navigate });
  useLayoutEffect(() => {
    latest.current = { openKey, started, moves, isOffline, onClosed, navigate };
  });

  const openThread = useCallback((sessionId: string): void => {
    void latest.current.navigate({ to: "/threads/$sessionId", params: { sessionId } });
  }, []);

  const start = useMutation({
    mutationKey: START_KEY,
    mutationFn: (sent: SentThread) => {
      requireSignedIn(scope);
      return client.session.spawn({ payload: sent.input });
    },
    // Registered here rather than passed to `mutate`, so a thread that starts
    // after the user closed the dialog is still taken in.
    onSuccess: async (session, sent) => {
      if (!scope.isCurrent()) return;
      // The thread screen opens on this session without reading it again.
      queryClient.setQueryData(queryKeys.session(session.id), session);
      void queryClient.invalidateQueries({
        queryKey: threadAndAgentSessionsQuery(client).queryKey,
      });
      if (sent.recent !== null) rememberRecentModel(controller.url, sent.recent);
      pendingSubmissions.clearSent(buildThreadStartImagesKey(sent.draftKey), {
        text: "",
        attachments: sent.attachments,
        picks: {},
      });
      const refs = sent.things.map((thing) => thing.ref);
      visit.confirmMove(visit.move("taken", refs));
      taken.current = refs;
      latest.current.moves.sayThreadStarted(sent.title, () => {
        openThread(session.id);
      });
      if (latest.current.openKey === sent.draftKey) {
        // The started dialog measures the transcript as it appears, so its reads and its code
        // are loaded first. When the reads fail, the transcript shows its own state rather
        // than the dialog waiting.
        await Promise.all([
          ensureThreadData(queryClient, client, session.id).catch(() => undefined),
          loadThreadFirstMoments(),
        ]);
        if (!scope.isCurrent()) return;
      }
      if (latest.current.openKey === sent.draftKey) {
        // The draft stays until the dialog closes, which the started dialog is drawn from.
        setStarted({
          sessionId: session.id,
          title: sent.title,
          summary: sent.summary,
          thingCount: sent.things.length,
        });
      } else {
        drafts.finish(sent.draftKey);
      }
    },
    // Kept in the draft rather than read from the mutation, so it shows also
    // when the dialog was closed and opened again before the start failed.
    onError: (error, sent) => {
      if (!scope.isCurrent()) return;
      const failure = describeThreadStartError(sent.title, error);
      drafts.recordFailure(sent.draftKey, failure);
      // A closed dialog shows nothing, so the undo line says it.
      if (latest.current.openKey !== sent.draftKey) latest.current.moves.say(failure);
    },
  });
  const { mutate: startThread } = start;

  const open = useCallback(
    (hoveredKey?: string): void => {
      if (isOpening.current) return;
      const start = latest.current.moves.readThreadStart(hoveredKey, (targets) =>
        hasAttemptedSend(drafts, targets),
      );
      if (start === null) return;
      const { things, title } = start;
      const key = buildThingsDraftKey(things.map((thing) => thing.id));
      isOpening.current = true;
      // The composer is built from these two, which no other screen reads on the way here.
      Promise.all([
        queryClient.ensureQueryData(settingsQuery(client)),
        queryClient.ensureQueryData(profilesQuery(client)),
      ]).then(
        () => {
          if (!scope.isCurrent()) return;
          drafts.open(key, things, title);
          setStarted(null);
          setOpenKey(key);
        },
        (error: unknown) => {
          isOpening.current = false;
          if (scope.isCurrent()) {
            latest.current.moves.say(
              `Start a thread could not read your settings: ${readReason(error)}.`,
            );
          }
        },
      );
    },
    [client, drafts, queryClient, scope],
  );

  const close = useCallback((): void => {
    const { openKey: key, onClosed: tellClosed } = latest.current;
    if (
      key !== null &&
      drafts.settle(key, {
        isStarting: isMutationRunning(queryClient, START_KEY),
        hasStarted: latest.current.started !== null,
      })
    ) {
      latest.current.moves.say(WORDS_KEPT);
    }
    setOpenKey(null);
    setStarted(null);
    isOpening.current = false;
    const snapshot = visit.getSnapshot();
    if (snapshot.rows.length === 0) taken.current = null;
    tellClosed(snapshot);
  }, [drafts, queryClient, visit]);

  const send = useCallback(
    (sent: SentThread): void => {
      if (isMutationRunning(queryClient, START_KEY)) return;
      // The connection may have dropped since the dialog opened.
      const { isOffline: offline } = latest.current;
      drafts.recordFailure(sent.draftKey, offline ? REFUSED_OFFLINE : null);
      if (!offline) startThread(sent);
    },
    [drafts, queryClient, startThread],
  );

  // The list drops a thing that is taken from "Someone waits on me" on its next read, which can
  // empty the list after the dialog closed. The focus then goes to the empty state, as for a move.
  useEffect(
    () =>
      visit.subscribe(() => {
        const refs = taken.current;
        if (refs === null || latest.current.openKey !== null) return;
        const snapshot = visit.getSnapshot();
        if (snapshot.status !== "ready") return;
        if (snapshot.rows.length === 0) {
          taken.current = null;
          latest.current.onClosed(snapshot);
        } else if (!snapshot.rows.some((row) => refs.includes(row.ref))) {
          taken.current = null;
        }
      }),
    [visit],
  );

  // The started dialog's draft is only kept for it to be drawn: leaving the Inbox ends it.
  useEffect(
    () => () => {
      const { openKey: key, started: wasStarted } = latest.current;
      if (key !== null && wasStarted !== null) drafts.finish(key);
    },
    [drafts],
  );

  const isStarting = start.isPending;
  const element = useMemo(
    () =>
      openKey === null ? null : (
        <InboxThreadDialog
          key={openKey}
          drafts={drafts}
          draftKey={openKey}
          started={started}
          isStarting={isStarting}
          onSend={send}
          onOpenThread={openThread}
          onClose={close}
        />
      ),
    [openKey, drafts, started, isStarting, send, openThread, close],
  );
  return useMemo(() => ({ open, element }), [open, element]);
}
