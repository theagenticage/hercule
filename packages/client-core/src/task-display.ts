/**
 * How a task is shown on screen.
 *
 * Priority is drawn with shape and grey, never with colour. That leaves two
 * ways to show four levels: how many of the three bars are filled, and how
 * dark they are. The mapping lives here with a test rather than inside a
 * component.
 */
import type { ProvenanceEntry, TaskPriority, TaskStatus } from "@hercule/contract";

/** The grey a glyph is painted in. */
export type GlyphTone = "faint" | "muted" | "ink";

export interface PriorityReading {
  readonly filled: 1 | 2 | 3;
  readonly tone: GlyphTone;
}

const GLYPHS: Record<TaskPriority, PriorityReading> = {
  low: { filled: 1, tone: "faint" },
  normal: { filled: 2, tone: "muted" },
  high: { filled: 3, tone: "muted" },
  urgent: { filled: 3, tone: "ink" },
};

/** Returns how many bars to fill for a priority, and in which grey. */
export const readPriorityGlyph = (priority: TaskPriority): PriorityReading => GLYPHS[priority];

/** The statuses of a task that is no longer being worked on. */
const SETTLED: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["done", "cancelled"]);

/**
 * Checks whether a task row should be shown faded. Finished tasks and
 * low-priority tasks both fade, so the rows that stand out are the work that
 * is left to do.
 */
export const shouldTaskRecede = (task: {
  readonly status: TaskStatus;
  readonly priority: TaskPriority;
}): boolean => SETTLED.has(task.status) || task.priority === "low";

/**
 * Returns what a provenance entry points to, as one line. An entry has at
 * least one of a ref, an event id and a run id; the line lists every one it
 * has.
 */
export const describeProvenanceTarget = (entry: ProvenanceEntry): string => {
  const parts: string[] = [];
  if (entry.ref !== undefined) parts.push(entry.ref);
  if (entry.eventId !== undefined) parts.push(`event ${String(entry.eventId)}`);
  if (entry.runId !== undefined) parts.push(`run ${entry.runId}`);
  return parts.join(" · ");
};
