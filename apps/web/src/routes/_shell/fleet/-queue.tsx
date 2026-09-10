import type { JSX } from "react";
import { QueuedMark, Row } from "@hydra/ui";

/** One queued session, as the block reads it: nothing but what it shows. */
export interface QueueRow {
  readonly id: string;
  readonly title: string;
  readonly age: string;
}

/**
 * The runner page's session block: how full the machine is, and - only when
 * something is waiting - the queue itself, oldest first. Presentational: the
 * route reads the sessions, works out the line and the ordering, and hands
 * both down.
 */
export function SessionQueue({
  line,
  queue,
}: {
  readonly line: string;
  readonly queue: ReadonlyArray<QueueRow>;
}): JSX.Element {
  return (
    <Row label="Sessions">
      <div className="flex flex-col gap-1">
        <span className="text-row text-ink">{line}</span>
        {queue.map((session) => (
          <div key={session.id} className="flex items-center gap-2 text-row">
            <QueuedMark />
            <span className="min-w-0 flex-1 truncate text-muted">{session.title}</span>
            <span className="shrink-0 font-mono text-fine text-faint tabular-nums">
              {session.age}
            </span>
          </div>
        ))}
      </div>
    </Row>
  );
}
