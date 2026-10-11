/**
 * The moves on Intake that send nothing to the source: Done, Snooze,
 * Unsnooze and Not urgent, made on a row, from the bulk bar, with a key or
 * from the pane (spec 17 §Row controls and the bulk bar). The screen runs
 * them through `useSignalMoves`, and the pane reaches the same moves through
 * `IntakeMovesContext`.
 */
import { createContext, use, useState } from "react";
import {
  useMutation,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import type { Signal, SignalFilter, SignalPage, SignalView } from "@hercule/contract";
import {
  describeMoveToast,
  describeSnoozeUntil,
  invalidateWithoutCancelling,
  queryKeys,
  readErrorMessage,
  type BulkPlan,
  type HerculeClient,
} from "@hercule/client-core";
import { signalsToDoQuery } from "../../app/queries";

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
  readonly plan: BulkPlan;
  readonly until: string | undefined;
}

/** The moves, as the screen and the pane use them. */
export interface SignalMoves {
  /** The plan being sent, whose rows hold their highlight until they leave. `null` when none is. */
  readonly acting: BulkPlan | null;
  readonly toast: MoveToast | null;
  /**
   * Sends `plan`, with `until` for Snooze, then calls `onMoved` once the rows
   * have left the lists. Does nothing while another move is being sent, or
   * when the plan applies to no row.
   */
  readonly run: (plan: BulkPlan, until?: string, onMoved?: () => void) => void;
  readonly dismissToast: () => void;
}

/**
 * Sends `plan` to the controller with the operation of its move. Fails with
 * the controller's error.
 */
const sendMove = async (client: HerculeClient, { plan, until }: MoveInput): Promise<unknown> => {
  const payload = { signalIds: plan.signalIds };
  switch (plan.move) {
    case "done":
      return client.signal.markDone({ payload });
    case "snooze":
      return client.signal.snooze({ payload: { ...payload, until: until! } });
    case "unsnooze":
      return client.signal.unsnooze({ payload });
    case "not-urgent":
      return client.signal.lowerPriority({ payload });
  }
};

/**
 * Returns the length of one beat, `--dur-2`, in milliseconds, as the page's
 * stylesheet sets it: 0 under Reduce motion, and 0 when no stylesheet sets
 * it, as in tests.
 */
const readBeatDuration = (): number => {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--dur-2").trim();
  const amount = Number.parseFloat(value);
  if (Number.isNaN(amount)) return 0;
  return value.endsWith("ms") ? amount : amount * 1000;
};

/** Waits one beat: the acted rows hold their highlight that long before they leave. */
const waitOneBeat = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, readBeatDuration());
  });

/** Checks whether a query of the signals lists the view `view`. */
const isViewQuery = (queryKey: readonly unknown[], view: SignalView): boolean =>
  queryKey[0] === "signals" && (queryKey[1] as SignalFilter | undefined)?.view === view;

/**
 * Takes the signals `plan` moved out of the lists they left, in the cache,
 * so they leave at once rather than when the lists are read again:
 *
 * - Done and Snooze take them off To do; Not urgent lowers them there to
 *   `high`, which moves them from Now to Signals.
 * - Done and Unsnooze take them off Later.
 *
 * The reads that follow bring the rest, such as a snoozed signal on Later.
 */
const removeMovedSignals = (queryClient: QueryClient, client: HerculeClient, plan: BulkPlan) => {
  const moved = new Set(plan.signalIds);
  if (plan.move === "done" || plan.move === "snooze") {
    queryClient.setQueryData(signalsToDoQuery(client).queryKey, (signals) =>
      signals?.filter((signal) => !moved.has(signal.id)),
    );
  }
  if (plan.move === "not-urgent") {
    queryClient.setQueryData(signalsToDoQuery(client).queryKey, (signals) =>
      signals?.map((signal): Signal =>
        moved.has(signal.id) ? { ...signal, priority: "high" } : signal,
      ),
    );
  }
  if (plan.move === "done" || plan.move === "unsnooze") {
    queryClient.setQueriesData<InfiniteData<SignalPage>>(
      { predicate: (query) => isViewQuery(query.queryKey, "later") },
      (data) =>
        data && {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.filter((signal) => !moved.has(signal.id)),
          })),
        },
    );
  }
};

/**
 * Runs Intake's moves for the user whose times are in `timezone`.
 *
 * A move holds its rows for one beat while it is sent, then takes them off
 * the lists, reads the lists and each moved signal again, and shows what it
 * did in the toast. A failed move shows its error in the toast's place, and
 * the rows stay where they were.
 */
export const useSignalMoves = (client: HerculeClient, timezone: string): SignalMoves => {
  const queryClient = useQueryClient();
  const [toast, setToast] = useState<MoveToast | null>(null);
  const showToast = (text: string, failed: boolean): void => {
    setToast((shown) => ({ serial: (shown?.serial ?? 0) + 1, text, failed }));
  };

  const move = useMutation({
    mutationFn: async (input: MoveInput) => {
      // The beat runs beside the call, so a fast answer still lets the user
      // see which rows are about to leave, and a slow one adds no wait.
      await Promise.all([sendMove(client, input), waitOneBeat()]);
    },
    onSuccess: (_, { plan, until }) => {
      removeMovedSignals(queryClient, client, plan);
      invalidateWithoutCancelling(queryClient, queryKeys.signals());
      for (const signalId of plan.signalIds) {
        invalidateWithoutCancelling(queryClient, queryKeys.signal(signalId));
      }
      showToast(
        describeMoveToast(
          plan,
          until === undefined ? undefined : describeSnoozeUntil(until, new Date(), timezone),
        ),
        false,
      );
    },
    onError: (error) => {
      showToast(readErrorMessage(error), true);
    },
  });

  return {
    acting: move.isPending ? move.variables.plan : null,
    toast,
    run: (plan, until, onMoved) => {
      if (move.isPending || plan.signalIds.length === 0) return;
      move.mutate({ plan, until }, onMoved === undefined ? undefined : { onSuccess: onMoved });
    },
    dismissToast: () => {
      setToast(null);
    },
  };
};

/** What the pane needs of Intake's moves, given by the screen. */
export interface IntakeMoves {
  readonly view: SignalView;
  /** Whether a move is being sent; the pane's controls do nothing until it ends. */
  readonly pending: boolean;
  readonly run: (plan: BulkPlan, until?: string) => void;
  /** Opens the snooze menu for `signals` at `place`, or closes it when it is open there. */
  readonly toggleSnoozeMenu: (place: SnoozeMenuPlace, signals: ReadonlyArray<Signal>) => void;
  /** Where the snooze menu is open, or `null` when it is closed. */
  readonly snoozeMenuPlace: SnoozeMenuPlace | null;
  /** Selects a signal, as a click on its row does. */
  readonly select: (signalId: string) => void;
}

/** Carries Intake's moves from the screen to the pane. */
export const IntakeMovesContext = createContext<IntakeMoves | null>(null);

/** Returns Intake's moves. Fails when called outside Intake's screen, which gives them. */
export const useIntakeMoves = (): IntakeMoves => {
  const moves = use(IntakeMovesContext);
  if (moves === null) throw new Error("useIntakeMoves is called outside Intake's screen.");
  return moves;
};
