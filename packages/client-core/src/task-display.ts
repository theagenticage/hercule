/**
 * How a task reads on screen.
 *
 * Priority is drawn in shape and grey and never in colour, which leaves two
 * axes for four steps: how many of the three bars are painted, and how dark
 * they are. That mapping is a reading of the domain, so it lives here with a
 * test rather than inside a component.
 */
import type { ProvenanceEntry, TaskPriority, TaskStatus } from "@hydra/contract";

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

/** The bars and the grey one priority is drawn with. */
export const priorityGlyph = (priority: TaskPriority): PriorityReading => GLYPHS[priority];

/** The statuses a task is no longer worked on in. */
const SETTLED: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["done", "cancelled"]);

/**
 * Whether a row steps back out of the way. Work that is finished and work that
 * was never urgent both recede, so what is left reads as what is left to do.
 */
export const taskRecedes = (task: {
  readonly status: TaskStatus;
  readonly priority: TaskPriority;
}): boolean => SETTLED.has(task.status) || task.priority === "low";

/**
 * What one provenance entry points at, as one line. An entry names at least one
 * of the three, and an entry naming several says all of them.
 */
export const provenanceTarget = (entry: ProvenanceEntry): string => {
  const parts: string[] = [];
  if (entry.ref !== undefined) parts.push(entry.ref);
  if (entry.eventId !== undefined) parts.push(`event ${String(entry.eventId)}`);
  if (entry.runId !== undefined) parts.push(`run ${entry.runId}`);
  return parts.join(" · ");
};
