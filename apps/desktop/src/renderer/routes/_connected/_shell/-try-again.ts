/**
 * Trying a failed run again from the Work board (`run.rerun`), and the Undo
 * the undo line offers for it (`task.undoTryAgain`).
 *
 * The state of the requests is the requests themselves, kept in the query
 * client's mutation cache, not in a component. A component forgets them: the
 * user can leave Work, or open another Task, while a request is on its way,
 * and a rebuilt screen that forgot it would let a second press start a second
 * run on the same Task. This is the lock `useRerunTracking` keeps for Intake
 * (`screens/intake/use-rerun-tracking.ts`), with the same rules:
 *
 * - The mutation never goes out of the cache by time (`gcTime: Infinity`).
 * - The lock ends when the board no longer shows that run as the Task's
 *   failure, or when the controller refuses the request. Never after a time.
 * - The cache keeps one request per Task: a new press removes the Task's
 *   earlier ones, which have ended.
 * - The mutation's own options run for every request, also after the screen
 *   that sent it is gone.
 */
import {
  useMutation,
  useQueryClient,
  type Mutation,
  type QueryClient,
} from "@tanstack/react-query";
import {
  invalidateWithoutCancelling,
  queryKeys,
  readErrorMessage,
  type HerculeClient,
} from "@hercule/client-core";
import { describeTryAgain, describeTryAgainUndo } from "@hercule/client-core/work";
import type { WorkCard } from "@hercule/contract";
import type { CardMover } from "../../../app/card-mover";
import { buildStillSignedInCheck } from "../../../app/still-signed-in";
import type { Gesture } from "../../../app/undo-stack";

/** The key every Try again runs under, so the screen can find the requests. */
const TRY_AGAIN_KEY = ["work-try-again"];

/** What a Try again request asks for: the failed run to run again, and the Task and title it belongs to. */
interface TryAgainRequest {
  readonly taskId: string;
  readonly runId: string;
  readonly title: string;
  /** Tells whether the user who pressed Try again is still signed in. */
  readonly isStillSignedIn: () => boolean;
}

/** The failed card a Try again needs: its Task, its title and the run that failed. */
export type FailedCard = Pick<WorkCard, "id" | "title"> & {
  readonly failure: NonNullable<WorkCard["failure"]>;
};

/** Returns the Try again requests of the Task `taskId` that the mutation cache holds. */
const findRequests = (queryClient: QueryClient, taskId: string): Mutation[] =>
  queryClient
    .getMutationCache()
    .findAll({ mutationKey: TRY_AGAIN_KEY })
    .filter((mutation) => (mutation.state.variables as TryAgainRequest).taskId === taskId);

/** Removes the Task's Try again requests, which ends their lock. */
const releaseTask = (queryClient: QueryClient, taskId: string): void => {
  for (const mutation of findRequests(queryClient, taskId)) {
    queryClient.getMutationCache().remove(mutation);
  }
};

/**
 * Removes the Try again request `request` only, which ends its lock. An older
 * gesture's Undo must not end the lock of a newer press on the same Task.
 */
const releaseRequest = (queryClient: QueryClient, request: TryAgainRequest): void => {
  for (const mutation of findRequests(queryClient, request.taskId)) {
    if (mutation.state.variables === request) queryClient.getMutationCache().remove(mutation);
  }
};

/**
 * Returns whether a Try again of the run `runId` is starting on `taskId`: its
 * request is on its way, or it was accepted and the board still shows `runId`
 * as the Task's failure. Reads the mutation cache, not React state, because
 * `mutate` adds a request to the cache before anything renders.
 */
export const isTryAgainStarting = (
  queryClient: QueryClient,
  taskId: string,
  runId: string,
): boolean =>
  findRequests(queryClient, taskId).some(
    (mutation) =>
      mutation.state.status === "pending" ||
      (mutation.state.status === "success" &&
        (mutation.state.variables as TryAgainRequest).runId === runId),
  );

/** What the screen lends Try again, to show its result. */
interface TryAgainCallbacks {
  /**
   * Shows `text` on the undo line with Undo, and puts `gesture` on the undo
   * stack. Returns a function that takes it off again.
   */
  readonly sayWithUndo: (text: string, gesture: Gesture<CardMover>) => () => void;
  /** Shows `text` on the undo line with no Undo. */
  readonly sayWithoutUndo: (text: string) => void;
  /** Called with the Task's id when the controller started the run again. */
  readonly onStarted: (taskId: string) => void;
  /**
   * Called with the Task's id when Undo put the failure back, before the board
   * is read again, so the card still shows the colleague of the new run.
   */
  readonly onUndone: (taskId: string) => void;
}

/**
 * Returns the function that tries a failed card's run again. It returns
 * whether it sent the request, which it does not when a Try again of that
 * run is already starting.
 */
export const useTryAgain = (
  client: HerculeClient,
  callbacks: TryAgainCallbacks,
): ((card: FailedCard) => boolean) => {
  const queryClient = useQueryClient();
  const rerun = useMutation({
    mutationKey: TRY_AGAIN_KEY,
    // A finished request is the lock until the board shows another failure, so
    // no time may drop it. A new press and an Undo remove the Task's requests.
    gcTime: Infinity,
    mutationFn: ({ runId }: TryAgainRequest) =>
      client.run.rerun({ params: { id: runId }, payload: {} }),
    onSuccess: (started, request) => {
      const { taskId, title } = request;
      // The user may have signed out while the request was on its way. Its
      // Undo would then run as the next account.
      if (!request.isStillSignedIn()) return;
      // The `run` push brings the board too. This makes sure a read that
      // started after the run committed arrives, even if that push is lost,
      // so the lock always ends.
      invalidateWithoutCancelling(queryClient, queryKeys.workBoard());
      invalidateWithoutCancelling(queryClient, queryKeys.taskDetail(taskId));
      const words = describeTryAgain(title);
      callbacks.sayWithUndo(`${words}.`, {
        words,
        undo: async () => {
          try {
            const answer = await client.task.undoTryAgain({
              params: { id: taskId },
              payload: { runId: started.runId },
            });
            const result = describeTryAgainUndo(answer);
            if (result.kind === "stayed") throw new Error(result.reason);
            callbacks.onUndone(taskId);
            return undefined;
          } finally {
            // The failure is back, or the Task stays as it is: either way the
            // run is no longer one to wait for.
            releaseRequest(queryClient, request);
            invalidateWithoutCancelling(queryClient, queryKeys.workBoard());
            invalidateWithoutCancelling(queryClient, queryKeys.taskDetail(taskId));
          }
        },
      });
      callbacks.onStarted(taskId);
    },
    onError: (error, { title, isStillSignedIn }) => {
      if (!isStillSignedIn()) return;
      callbacks.sayWithoutUndo(`Could not try ${title} again: ${readErrorMessage(error)}`);
    },
  });
  return (card) => {
    const { id: taskId, title, failure } = card;
    if (isTryAgainStarting(queryClient, taskId, failure.runId)) return false;
    // Every earlier request has ended or was refused, so the new one replaces them.
    releaseTask(queryClient, taskId);
    rerun.mutate({
      taskId,
      runId: failure.runId,
      title,
      isStillSignedIn: buildStillSignedInCheck(client),
    });
    return true;
  };
};
