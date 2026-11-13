/**
 * The Inbox's start-thread dialog: N, a row's button and the pane's button
 * open it on the things the move is for, and sending it makes one new Task
 * from those things and a thread on it (`session.spawn` with `newTask`).
 *
 * - What the user writes is kept per set of things (`AccountScope.threadStarts`),
 *   so closing the dialog unsent and pressing N on the same things opens the
 *   words again. A dialog closed without a change keeps nothing.
 * - A thread that started is not undone: the undo line says so with an "Open
 *   it" button, and nothing goes on the undo stack.
 * - Every continuation of a request first asks the account scope that the user
 *   is still the one signed in.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
} from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { isMutationRunning, queryKeys } from "@hercule/client-core";
import { buildThingsDraftKey, describeInboxThreadStartFailure } from "@hercule/client-core/inbox";
import type { SavedController } from "../../../app/context";
import { requireSignedIn, type AccountScope } from "../../../app/account-scope";
import { profilesQuery, settingsQuery, threadAndAgentSessionsQuery } from "../../../app/queries";
import { readReason } from "../../../app/read-reason";
import { rememberRecentModel } from "../../../app/recent-models";
import { buildThreadStartDraft } from "../../../app/thread-start-drafts";
import type { InboxMoves } from "./-inbox-moves";
import {
  InboxThreadDialog,
  buildThreadStartImagesKey,
  type SentThread,
  type StartedThread,
} from "./-inbox-thread-dialog";
import type { InboxListSnapshot, InboxListVisit } from "./-inbox-visit";

/** The key every start of a thread runs under, so a second press while one is on its way sends nothing. */
const START_KEY = ["inbox-thread-start"];

const WORDS_KEPT = "Your words are kept. N on the same things opens them again.";

/** What `useInboxThread` returns. */
export interface InboxThread {
  /**
   * Opens the dialog on the things the move is for: the selection, else the
   * current row, or with `hoveredRef` that row (see `InboxMoves.dismiss`). A
   * refusal says why on the undo line and opens nothing. The dialog waits for
   * the settings and profiles it reads, so it opens a moment after the call.
   */
  readonly open: (hoveredRef?: string) => void;
  /** The dialog while it is open, else `null`: the screen draws it with its overlays. */
  readonly element: JSX.Element | null;
}

/**
 * Makes the start-thread dialog of the Inbox for `controller`, over the list
 * `visit` holds, with the undo line and the refusals of `moves`. `onClosed`
 * is called with the list as it is when the dialog closes, and again when the
 * list empties after the thread's things left it, so the screen can put the
 * focus on the current row or on the empty state: the page behind a modal
 * dialog cannot take the focus while it is open.
 */
export function useInboxThread({
  controller,
  scope,
  visit,
  moves,
  onClosed,
}: {
  readonly controller: SavedController;
  readonly scope: AccountScope;
  readonly visit: InboxListVisit;
  readonly moves: InboxMoves;
  readonly onClosed: (snapshot: InboxListSnapshot) => void;
}): InboxThread {
  const { client, pendingSubmissions } = controller;
  const { threadStarts: drafts } = scope;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const openThread = (sessionId: string): void => {
    void navigate({ to: "/threads/$sessionId", params: { sessionId } });
  };
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [started, setStarted] = useState<StartedThread | null>(null);
  const draft = useSyncExternalStore(drafts.subscribe, () =>
    openKey === null ? undefined : drafts.read(openKey),
  );
  const isOpening = useRef(false);
  // The refs of the things a started thread took, while the list may still drop them.
  const taken = useRef<readonly string[] | null>(null);

  // A continuation of a request outlives the render that made it, so it reads the newest of these.
  const latest = useRef({ openKey, started, moves, onClosed });
  useLayoutEffect(() => {
    latest.current = { openKey, started, moves, onClosed };
  });

  const start = useMutation({
    mutationKey: START_KEY,
    mutationFn: (sent: SentThread) => {
      requireSignedIn(scope);
      return client.session.spawn({ payload: sent.input });
    },
    // Registered here rather than passed to `mutate`, so a thread that starts
    // after the user closed the dialog is still taken in.
    onSuccess: (session, sent) => {
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
        // The draft stays until the dialog closes, which the started dialog is drawn from.
        setStarted({
          sessionId: session.id,
          title: sent.title,
          summary: sent.summary,
          thingCount: sent.things.length,
        });
      } else {
        drafts.drop(sent.draftKey);
      }
    },
    // Kept in the draft rather than read from the mutation, so it shows also
    // when the dialog was closed and opened again before the start failed.
    onError: (error, sent) => {
      if (!scope.isCurrent()) return;
      const current = drafts.read(sent.draftKey);
      if (current === undefined) return;
      drafts.write(sent.draftKey, {
        ...current,
        failure: describeInboxThreadStartFailure(sent.title, readReason(error)),
      });
    },
  });

  const open = (hoveredRef?: string): void => {
    if (isOpening.current) return;
    const things = moves.readStartTargets(hoveredRef);
    if (things === null) return;
    const key = buildThingsDraftKey(things.map((thing) => thing.id));
    isOpening.current = true;
    // The composer is built from these two, which no other screen reads on the way here.
    Promise.all([
      queryClient.ensureQueryData(settingsQuery(client)),
      queryClient.ensureQueryData(profilesQuery(client)),
    ]).then(
      () => {
        if (!scope.isCurrent()) return;
        if (drafts.read(key) === undefined) drafts.write(key, buildThreadStartDraft(things));
        setStarted(null);
        setOpenKey(key);
      },
      (error: unknown) => {
        isOpening.current = false;
        if (scope.isCurrent()) {
          moves.say(`Start a thread could not read your settings: ${readReason(error)}.`);
        }
      },
    );
  };

  /** Keeps what the user wrote of the draft at `key` when it was changed, else drops it. */
  const settleDraft = (key: string): void => {
    const current = drafts.read(key);
    if (current === undefined) return;
    if (started !== null) {
      drafts.drop(key);
    } else if (isMutationRunning(queryClient, START_KEY)) {
      // The start decides: success drops the draft and failure keeps it with its message.
    } else if (current.isEdited) {
      moves.say(WORDS_KEPT);
    } else {
      drafts.drop(key);
    }
  };

  const close = (): void => {
    if (openKey !== null) settleDraft(openKey);
    setOpenKey(null);
    setStarted(null);
    isOpening.current = false;
    const snapshot = visit.getSnapshot();
    if (snapshot.rows.length === 0) taken.current = null;
    onClosed(snapshot);
  };

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
      if (key !== null && wasStarted !== null) drafts.drop(key);
    },
    [drafts],
  );

  const element =
    openKey === null || draft === undefined ? null : (
      <InboxThreadDialog
        key={openKey}
        drafts={drafts}
        draftKey={openKey}
        draft={draft}
        started={started}
        isStarting={start.isPending}
        onSend={(sent) => {
          if (isMutationRunning(queryClient, START_KEY)) return;
          const current = drafts.read(sent.draftKey);
          if (current !== undefined) drafts.write(sent.draftKey, { ...current, failure: null });
          start.mutate(sent);
        }}
        onOpenThread={openThread}
        onClose={close}
      />
    );
  return { open, element };
}
