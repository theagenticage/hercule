/** Test details for the Task pane, in the invented Northwind Market world. */
import type { SessionRequest, TaskDetailSession, WorkCard } from "@hercule/contract";
import type { TaskQuestionSource } from "./question-answers";
import { buildCard } from "./cards.testing";

type QuestionRequest = Extract<SessionRequest, { readonly kind: "question" }>;
type Question = QuestionRequest["detail"]["questions"][number];

/** Returns one question of a Request, with a single choice and no options. */
export const buildQuestion = (header: string, overrides: Partial<Question> = {}): Question => ({
  header,
  question: "Should refunds go back to the original card?",
  options: [],
  multiSelect: false,
  ...overrides,
});

/** Returns an open `question` Request of the given id holding these questions. */
export const buildQuestionRequest = (
  requestId: string,
  questions: readonly [Question, ...Question[]],
  overrides: Partial<QuestionRequest> = {},
): QuestionRequest => ({
  requestId,
  itemId: `item-${requestId}`,
  kind: "question",
  detail: { questions },
  ...overrides,
});

/** Returns an open approval Request of the given id. */
export const buildApprovalRequest = (requestId: string): SessionRequest => ({
  requestId,
  itemId: `item-${requestId}`,
  kind: "command_approval",
  detail: { command: "git push" },
  decisions: ["allow", "deny"],
});

/** Returns a Thread of a Task that is idle, with no Request open. `overrides` change any field. */
export const buildDetailSession = (
  id: string,
  overrides: Partial<TaskDetailSession> = {},
): TaskDetailSession => ({
  id,
  title: `Thread ${id}`,
  role: null,
  kind: "thread",
  status: "idle",
  openRequests: [],
  done: false,
  ...overrides,
});

/** Returns what the pane reads of a Task: its card and its Threads. */
export const buildDetail = (
  card: WorkCard,
  ...sessions: readonly TaskDetailSession[]
): TaskQuestionSource => ({ card, sessions });

/** Returns a card whose open question is `requestId` on `sessionId`. */
export const buildAskingCard = (sessionId: string, requestId: string): WorkCard =>
  buildCard("task-1", { openQuestion: { sessionId, requestId, text: "ignored" } });
