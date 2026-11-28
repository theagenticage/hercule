/**
 * The title of a Task. It lives in a module of its own because both the Task
 * schemas (`task.ts`) and `session.spawn` (`session.ts`) need it, and `task.ts`
 * already imports `session.ts`.
 */
import { bounded } from "../strings";

/** The longest title. A title is a line, not a paragraph. */
export const MAX_TASK_TITLE_LENGTH = 512;

/** The title of a Task: at least one character and at most `MAX_TASK_TITLE_LENGTH`. */
export const TaskTitle = bounded(1, MAX_TASK_TITLE_LENGTH);
