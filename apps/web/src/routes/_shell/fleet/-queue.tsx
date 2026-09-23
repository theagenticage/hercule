import type { JSX } from "react";
import { QueuedMark, Row } from "@hercule/ui";

/** One queued session, with only the fields the block shows. */
export interface QueueRow {
  readonly id: string;
  readonly title: string;
  readonly age: string;
}

/**
 * The session block on the runner page: how full the runner is and, when
 * sessions are waiting, the queue itself, oldest first. The route reads the
 * sessions and computes the line and the order; this component only shows them.
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
