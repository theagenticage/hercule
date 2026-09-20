import type { JSX } from "react";
import { formatStamp, priorityGlyph, taskRecedes } from "@hercule/client-core";
import type { Task } from "@hercule/contract";
import { ListRow, PriorityGlyph } from "@hercule/ui";

/**
 * One task as a row: what it is, how much it matters, where it stands and where
 * it sits. Finished work and work that was never urgent both recede, so what is
 * left standing is what is left to do.
 */
export function TaskRow({
  task,
  project,
  timezone,
  selected,
  onOpen,
}: {
  readonly task: Task;
  readonly project: string;
  readonly timezone: string;
  readonly selected: boolean;
  readonly onOpen: () => void;
}): JSX.Element {
  const glyph = priorityGlyph(task.priority);

  return (
    <ListRow dimmed={taskRecedes(task)} selected={selected} onClick={onOpen}>
      <PriorityGlyph filled={glyph.filled} tone={glyph.tone} label={`${task.priority} priority`} />
      <span
        className={`min-w-0 flex-1 truncate text-ink ${task.priority === "urgent" ? "font-urgent" : "font-emph"}`}
      >
        {task.title}
      </span>
      <span className="flex shrink-0 gap-1.5">
        {task.labels.map((label) => (
          <span
            key={label}
            className="rounded-control bg-line-soft px-1.5 py-0.5 font-mono text-fine text-muted"
          >
            {label}
          </span>
        ))}
      </span>
      <span className="w-[84px] shrink-0 text-meta text-muted">{task.status}</span>
      <span className="w-[104px] shrink-0 truncate text-meta text-faint">{project}</span>
      <span className="w-[94px] shrink-0 text-right font-mono text-fine whitespace-nowrap text-faint tabular-nums">
        {formatStamp(new Date(task.updatedAt), timezone) ?? ""}
      </span>
    </ListRow>
  );
}
