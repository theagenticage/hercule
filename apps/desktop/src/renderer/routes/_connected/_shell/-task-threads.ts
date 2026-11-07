/**
 * Starting a Thread on a Task from the Work board (`session.spawn`) and moving
 * a Thread to a new Task of its own (`session.moveToTask`). Both say what
 * happened on the undo line, with no Undo, and read the board and the Task's
 * details again.
 *
 * - A Thread started from a card joins the Task by name (`taskId`), in the
 *   Task's Project, and in the workspace of the Task's newest session when
 *   that workspace is still ready. When it is not, the Thread starts without
 *   a workspace and the line says so (`buildTaskThreadStart`).
 * - Nothing here navigates: the user stays on Work.
 */
import { useState, type RefObject } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  invalidateWithoutCancelling,
  isNotFound,
  queryKeys,
  readErrorMessage,
  type HerculeClient,
} from "@hercule/client-core";
import {
  buildTaskThreadStart,
  chooseTaskCard,
  describeThreadRefused,
  describeThreadStarted,
  THREAD_MOVED_WORDS,
  type NewestSessionPlace,
} from "@hercule/client-core/work";
import type { TaskDetail, WorkCard } from "@hercule/contract";
import { buildStillSignedInCheck } from "../../../app/still-signed-in";
import { useHandOffs } from "../../../screens/work/use-hand-offs";
import type { TaskPaneChanges } from "../../../screens/work/task-pane";

/** What `useTaskThreadRequests` returns. */
interface TaskThreadRequests {
  /**
   * Starts a Thread on the Task of `card`, doing what `prompt` says. Says on
   * the undo line what happened, and calls `onStarted` with the Task's id once
   * the controller has started it.
   */
  readonly startThread: (card: WorkCard, prompt: string) => void;
  /**
   * Moves the Thread `sessionId`, which belongs to the Task `taskId`, to a new
   * Task made from it. Says on the undo line what happened.
   */
  readonly moveThreadToNewTask: (taskId: string, sessionId: string) => void;
}

/**
 * Reads where the newest session of the Task `taskId` worked: its workspace's
 * id, and the workspace itself. A workspace the controller no longer has reads
 * as `null`. Any other failure rejects, so a Thread never starts in a place
 * the user was not told about.
 */
const readNewestSessionPlace = async (
  client: HerculeClient,
  taskId: string,
): Promise<NewestSessionPlace> => {
  // Any kind of session counts: the Task's newest session may be an agent's or a run's.
  const page = await client.session.query({
    query: { taskId, sort: [{ field: "createdAt", direction: "desc" }], limit: 1 },
  });
  const workspaceId = page.items[0]?.workspaceId ?? null;
  if (workspaceId === null) return { workspaceId: null, workspace: null };
  try {
    return { workspaceId, workspace: await client.workspace.read({ params: { id: workspaceId } }) };
  } catch (error) {
    if (isNotFound(error)) return { workspaceId, workspace: null };
    throw error;
  }
};

/**
 * Returns the requests that start a Thread on a Task and move a Thread to a
 * new Task for `client`. `say` shows a line on the undo line with no Undo.
 * `onStarted` is called with the Task's id once the controller has started a
 * Thread on it. `onRefused` is called with the card and the prompt when the
 * start failed, so the caller can give the prompt back to the user.
 */
const useTaskThreadRequests = ({
  client,
  say,
  onStarted,
  onRefused,
}: {
  readonly client: HerculeClient;
  readonly say: (text: string) => void;
  readonly onStarted: (taskId: string) => void;
  readonly onRefused: (card: WorkCard, prompt: string) => void;
}): TaskThreadRequests => {
  const queryClient = useQueryClient();
  const readAgain = (taskId: string): void => {
    invalidateWithoutCancelling(queryClient, queryKeys.workBoard());
    invalidateWithoutCancelling(queryClient, queryKeys.taskDetail(taskId));
  };

  const start = useMutation({
    mutationFn: async ({
      card,
      prompt,
      isStillSignedIn,
    }: {
      card: WorkCard;
      prompt: string;
      isStillSignedIn: () => boolean;
    }) => {
      const place = await readNewestSessionPlace(client, card.id);
      // The read can end after sign-out, and the spawn would then go out as the next account.
      if (!isStillSignedIn()) throw new Error("You signed out before the thread started.");
      const { input, note } = buildTaskThreadStart(prompt, card, place);
      await client.session.spawn({ payload: input });
      return note;
    },
    onSuccess: (note, { card }) => {
      say(
        note === undefined ? describeThreadStarted(card) : `${describeThreadStarted(card)} ${note}`,
      );
      readAgain(card.id);
      onStarted(card.id);
    },
    onError: (error, { card, prompt, isStillSignedIn }) => {
      if (!isStillSignedIn()) return;
      say(describeThreadRefused(card, readErrorMessage(error)));
      onRefused(card, prompt);
    },
  });

  const move = useMutation({
    mutationFn: ({ sessionId }: { taskId: string; sessionId: string }) =>
      client.session.moveToTask({ params: { id: sessionId }, payload: {} }),
    onSuccess: (_, { taskId }) => {
      say(THREAD_MOVED_WORDS);
      readAgain(taskId);
    },
    onError: (error) => {
      say(`Could not move the thread to a new Task: ${readErrorMessage(error)}`);
    },
  });

  return {
    startThread: (card, prompt) => {
      start.mutate({ card, prompt, isStillSignedIn: buildStillSignedInCheck(client) });
    },
    moveThreadToNewTask: (taskId, sessionId) => {
      move.mutate({ taskId, sessionId });
    },
  };
};

/** The pane's buttons that `useTaskThreads` wires. */
export type TaskThreadChanges = Pick<
  TaskPaneChanges,
  "onStartThread" | "onSendThreadPrompt" | "onCancelThreadPrompt" | "onMoveThreadToNewTask"
>;

/** What `useTaskThreads` returns. */
export interface TaskThreadsState {
  /**
   * The words in the pane's foot line that asks what a new Thread should do:
   * empty for a new line, the user's own words after a start was refused. It
   * is `null` when the foot is not that line.
   */
  readonly threadPromptWords: string | null;
  /**
   * Asks what a new Thread on `card` should do (the `T` key): opens the pane
   * on that Task, with the foot as the line to write it on.
   */
  readonly askThread: (card: WorkCard) => void;
  readonly changes: TaskThreadChanges;
}

/**
 * Wires the pane's Start a thread and Move to a new Task buttons, and the `T`
 * key, for the Task `openTaskId` and its `cards`. `scrollRef` is the element
 * that scrolls the board, where the colleague of a Thread that was started is
 * brought up on its card (`useHandOffs`). `openPane` shows a Task's details,
 * `closePane` hides them, and `say` shows a line on the undo line with no
 * Undo.
 *
 * - Asking what a Thread should do is state of the pane, and it ends when the
 *   pane shows another Task or closes.
 * - Return on the line starts the Thread and closes the pane, so the user
 *   sees the colleague come up on the card. Esc takes the line back.
 * - When the controller refuses the start, the pane opens again on that Task
 *   with the line filled in with the words the user wrote, beside the undo
 *   line's refusal. Words are never lost to a failure.
 */
export const useTaskThreads = ({
  client,
  cards,
  openTaskId,
  scrollRef,
  say,
  openPane,
  closePane,
}: {
  readonly client: HerculeClient;
  readonly cards: readonly WorkCard[];
  readonly openTaskId: string | null;
  readonly scrollRef: RefObject<HTMLElement | null>;
  readonly say: (text: string) => void;
  readonly openPane: (card: WorkCard) => void;
  readonly closePane: () => void;
}): TaskThreadsState => {
  const queryClient = useQueryClient();
  const { noteHandOff } = useHandOffs(scrollRef, cards);
  const [askedTaskId, setAskedTaskId] = useState<string | null>(null);
  // What the line starts with: the words of a start that was refused, else nothing.
  const [askedWords, setAskedWords] = useState("");
  const requests = useTaskThreadRequests({
    client,
    say,
    onStarted: (taskId) => {
      noteHandOff(taskId, "colleague-arrives");
    },
    onRefused: (card, prompt) => {
      setAskedWords(prompt);
      setAskedTaskId(card.id);
      openPane(card);
    },
  });

  // Asking ends when the pane shows another Task, or none. The Task asked
  // about may be the one the pane is about to show (the `T` key opens it).
  const [seenOpenTaskId, setSeenOpenTaskId] = useState(openTaskId);
  if (seenOpenTaskId !== openTaskId) {
    setSeenOpenTaskId(openTaskId);
    if (askedTaskId !== openTaskId) setAskedTaskId(null);
  }

  /** Returns the open Task's card: the board's, else the one its details were read with. */
  const readOpenCard = (): WorkCard | undefined =>
    openTaskId === null
      ? undefined
      : chooseTaskCard(
          cards,
          openTaskId,
          queryClient.getQueryData<TaskDetail>(queryKeys.taskDetail(openTaskId)),
        );

  return {
    threadPromptWords: openTaskId !== null && askedTaskId === openTaskId ? askedWords : null,
    askThread: (card) => {
      setAskedWords("");
      setAskedTaskId(card.id);
      openPane(card);
    },
    changes: {
      onStartThread: () => {
        setAskedWords("");
        setAskedTaskId(openTaskId);
      },
      onSendThreadPrompt: (prompt) => {
        const card = readOpenCard();
        setAskedTaskId(null);
        if (card === undefined) return;
        requests.startThread(card, prompt);
        closePane();
      },
      onCancelThreadPrompt: () => {
        setAskedTaskId(null);
      },
      onMoveThreadToNewTask: (sessionId) => {
        if (openTaskId !== null) requests.moveThreadToNewTask(openTaskId, sessionId);
      },
    },
  };
};
