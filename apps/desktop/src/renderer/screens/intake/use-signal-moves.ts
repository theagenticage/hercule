/**
 * The moves on Intake that send nothing to the source: Done, Snooze,
 * Unsnooze and Not urgent, made on a row, from the bulk bar, with a key or
 * from the pane (spec 17 §Row controls and the bulk bar). The screen runs
 * them through `useSignalMoveRunner`, and the pane reaches the same moves
 * through `IntakeMovesContext`.
 */
import { createContext, use, useState } from "react";
import {
  useMutation,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import {
  MAX_SIGNAL_IDS,
  type Signal,
  type SignalFilter,
  type SignalPage,
  type SignalView,
} from "@hercule/contract";
import {
  applySignalMove,
  describeMoveToast,
  formatRelativeMoment,
  invalidateWithoutCancelling,
  queryKeys,
  readErrorMessage,
  type HerculeClient,
  type SignalMove,
  type SignalMovePlan,
} from "@hercule/client-core";
import { signalsToDoQuery } from "../../app/queries";
import { readMotionDuration } from "./motion-tokens";

/** Where the snooze menu opens: under a row's Snooze, above the bulk bar, or above the pane's Snooze. */
export type SnoozeMenuPlace = "row" | "bar" | "pane";

/** The line in the toast's place: what the last move did, or why it failed. */
export interface MoveToast {
  /** Counts the toasts shown, so a new toast replaces the last one and rises again. */
  readonly serial: number;
  readonly text: string;
  readonly failed: boolean;
}

/** What one call of a move sends: the plan, and for Snooze the time the signals come back. */
interface MoveInput {
  readonly plan: SignalMovePlan;
  readonly until: string | undefined;
}

/** The toast of the last move, and the ways to show and dismiss it. */
export interface MoveToastState {
  /** The line in the toast's place, or `null` when none shows. */
  readonly toast: MoveToast | null;
  /** Shows `text` in the toast's place, in place of the toast before it. A failed toast wears the failed mark. */
  readonly show: (text: string, failed: boolean) => void;
  readonly dismiss: () => void;
}

/** Intake's moves, as the screen runs them. */
export interface SignalMoveRunner {
  /** The plan being sent, whose rows hold their highlight until they leave. `null` when none is. */
  readonly acting: SignalMovePlan | null;
  /**
   * Sends `plan`, with `until` for Snooze, then calls `onMoved` once the
   * rows have left the lists. Does nothing while another move is being
   * sent, or when the plan applies to no row.
   */
  readonly run: (plan: SignalMovePlan, until?: string, onMoved?: () => void) => void;
}

/**
 * Keeps the toast of Intake's last move. The screen owns it, so every move
 * on the screen, a signal's or a Tracking row's, shows in the same place.
 */
export const useMoveToast = (): MoveToastState => {
  const [toast, setToast] = useState<MoveToast | null>(null);
  return {
    toast,
    show: (text, failed) => {
      setToast((shown) => ({ serial: (shown?.serial ?? 0) + 1, text, failed }));
    },
    dismiss: () => {
      setToast(null);
    },
  };
};

/**
 * Sends `move` for `signalIds`, at most `MAX_SIGNAL_IDS` of them, with
 * `until` for Snooze. Returns the ids the controller moved; it skips a
 * signal that was resolved meanwhile. Fails with the controller's error.
 */
const sendMoveBatch = async (
  client: HerculeClient,
  move: SignalMove,
  signalIds: ReadonlyArray<string>,
  until: string | undefined,
): Promise<ReadonlyArray<string>> => {
  const payload = { signalIds };
  switch (move) {
    case "done":
      return (await client.signal.markDone({ payload })).done;
    case "snooze":
      return (await client.signal.snooze({ payload: { ...payload, until: until! } })).snoozed;
    case "unsnooze":
      return (await client.signal.unsnooze({ payload })).unsnoozed;
    case "not-urgent":
      return (await client.signal.lowerPriority({ payload })).lowered;
  }
};

/**
 * Sends `plan` to the controller, one call per `MAX_SIGNAL_IDS` rows, one
 * after another, because a call takes no more ids than that. Returns every
 * id the controller moved. Fails with the first call's error; the calls
 * before it have already moved their signals.
 */
const sendMove = async (
  client: HerculeClient,
  { plan, until }: MoveInput,
): Promise<ReadonlyArray<string>> => {
  const signalIds = plan.acted.map((signal) => signal.id);
  const moved: string[] = [];
  for (let start = 0; start < signalIds.length; start += MAX_SIGNAL_IDS) {
    const batch = signalIds.slice(start, start + MAX_SIGNAL_IDS);
    moved.push(...(await sendMoveBatch(client, plan.move, batch, until)));
  }
  return moved;
};

/**
 * Waits one beat, `--dur-2`: the acted rows hold their highlight that long
 * before they leave. Under Reduce motion, and in tests, the beat is 0.
 */
const waitOneBeat = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, readMotionDuration("--dur-2"));
  });

/** Checks whether a query of the signals lists the view `view`. */
const isViewQuery = (queryKey: readonly unknown[], view: SignalView): boolean =>
  queryKey[0] === "signals" && (queryKey[1] as SignalFilter | undefined)?.view === view;

/**
 * Applies the move to To do and to every list of Later in the cache, as
 * `applySignalMove` describes, so the moved rows leave at once rather than
 * when the lists are read again. Done needs no change: a signal arrives
 * there only with the read.
 */
const applyMoveToCache = (
  queryClient: QueryClient,
  client: HerculeClient,
  move: SignalMove,
  movedIds: ReadonlyArray<string>,
): void => {
  queryClient.setQueryData(
    signalsToDoQuery(client).queryKey,
    (signals) => signals && [...applySignalMove(signals, "to-do", move, movedIds)],
  );
  queryClient.setQueriesData<InfiniteData<SignalPage>>(
    { predicate: (query) => isViewQuery(query.queryKey, "later") },
    (data) =>
      data && {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          items: [...applySignalMove(page.items, "later", move, movedIds)],
        })),
      },
  );
};

/** Reads every signal list again, and each signal in `signalIds`. */
const readSignalsAgain = (queryClient: QueryClient, signalIds: ReadonlyArray<string>): void => {
  invalidateWithoutCancelling(queryClient, queryKeys.signals());
  for (const signalId of signalIds) {
    invalidateWithoutCancelling(queryClient, queryKeys.signal(signalId));
  }
};

/**
 * Runs Intake's moves for the user whose times are in `timezone`.
 *
 * A move holds its rows for one beat while it is sent, then takes them off
 * the lists, reads the lists and each moved signal again, and shows in
 * `toast` what the controller did. A failed move shows its error in the
 * toast's place, and the rows stay where they were.
 *
 * `ownChanges` is told the ids of the signals a move acts on before it is
 * sent, so the list knows the change is the user's own even when a read
 * from the controller's push comes before the answer. The ids the move did
 * not change after all are forgotten again.
 */
export const useSignalMoveRunner = (
  client: HerculeClient,
  timezone: string,
  ownChanges: Pick<IntakeMoves, "registerOwnChanges" | "forgetOwnChanges">,
  toast: MoveToastState,
): SignalMoveRunner => {
  const queryClient = useQueryClient();
  const showToast = toast.show;

  const move = useMutation({
    mutationFn: async (input: MoveInput): Promise<ReadonlyArray<string>> => {
      // The beat runs beside the call, so a fast answer still lets the user
      // see which rows are about to leave, and a slow one adds no wait.
      const [moved] = await Promise.all([sendMove(client, input), waitOneBeat()]);
      return moved;
    },
    onMutate: ({ plan }) => {
      ownChanges.registerOwnChanges(plan.acted.map((signal) => signal.id));
    },
    onSuccess: (moved, { plan, until }) => {
      // Only the signals the controller moved are the user's own changes. A
      // signal it skipped, because it was resolved elsewhere meanwhile, left
      // the list through a change the user did not make.
      const movedIds = new Set(moved);
      ownChanges.forgetOwnChanges(
        plan.acted.map((signal) => signal.id).filter((id) => !movedIds.has(id)),
      );
      applyMoveToCache(queryClient, client, plan.move, moved);
      readSignalsAgain(queryClient, moved);
      const untilLabel =
        until === undefined
          ? undefined
          : formatRelativeMoment(new Date(until), new Date(), timezone);
      showToast(describeMoveToast(plan, moved, untilLabel), false);
    },
    onError: (error, { plan }) => {
      ownChanges.forgetOwnChanges(plan.acted.map((signal) => signal.id));
      // A move sent in several calls may have moved some signals before one
      // failed, so the lists are read again to show them where they are.
      readSignalsAgain(
        queryClient,
        plan.acted.map((signal) => signal.id),
      );
      showToast(`Couldn't ${describeFailedMove(plan.move)}: ${readErrorMessage(error)}`, true);
    },
  });

  return {
    acting: move.isPending ? move.variables.plan : null,
    run: (plan, until, onMoved) => {
      if (move.isPending || plan.acted.length === 0) return;
      move.mutate({ plan, until }, onMoved === undefined ? undefined : { onSuccess: onMoved });
    },
  };
};

/** Returns what a failed `move` could not do, as the toast completes "Couldn't …". */
const describeFailedMove = (move: SignalMove): string => {
  switch (move) {
    case "done":
      return "mark done";
    case "snooze":
      return "snooze";
    case "unsnooze":
      return "unsnooze";
    case "not-urgent":
      return "move out of Now";
  }
};

/** What the pane needs of Intake's moves, given by the screen. */
export interface IntakeMoves {
  readonly view: SignalView;
  /** Whether a move is being sent; the pane's controls do nothing until it ends. */
  readonly pending: boolean;
  readonly run: (plan: SignalMovePlan, until?: string) => void;
  /** Opens the snooze menu for `signals` at `place`, or closes it when it is open there. */
  readonly toggleSnoozeMenu: (place: SnoozeMenuPlace, signals: ReadonlyArray<Signal>) => void;
  /** Where the snooze menu is open, or `null` when it is closed. */
  readonly snoozeMenuPlace: SnoozeMenuPlace | null;
  /** Selects a signal, as a click on its row does. */
  readonly select: (signalId: string) => void;
  /**
   * Records that the user's own action changes `signalIds`, such as an
   * answer from the pane, so the list applies the change at once, even under
   * the pointer, and inbox zero arrives when it empties To do. Call it when
   * the action starts, before it is sent.
   */
  readonly registerOwnChanges: (signalIds: ReadonlyArray<string>) => void;
  /** Forgets the changes to `signalIds` an action did not make after all, such as a failed answer. */
  readonly forgetOwnChanges: (signalIds: ReadonlyArray<string>) => void;
  /**
   * Records that the user is handing the signal `signalId` off to an agent
   * from the pane: its row flies into Tracking, and the Task's row shows at
   * once, even under the pointer. Call it when the answer starts, before it is
   * sent. It is a change of the signal too, which `registerOwnChanges` records.
   */
  readonly registerHandoff: (signalId: string) => void;
  /** Forgets the handoff of `signalId`, because its answer failed. */
  readonly forgetHandoff: (signalId: string) => void;
}

/** Carries Intake's moves from the screen to the pane. */
export const IntakeMovesContext = createContext<IntakeMoves | null>(null);

/** Returns Intake's moves. Fails when called outside Intake's screen, which gives them. */
export const useIntakeMoves = (): IntakeMoves => {
  const moves = use(IntakeMovesContext);
  if (moves === null) throw new Error("useIntakeMoves is called outside Intake's screen.");
  return moves;
};
