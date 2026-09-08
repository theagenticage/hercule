/**
 * Sessions read the check-in page's lane shape here too, but nothing in this
 * build ever produces a waiting decision or an assistant session, so those two
 * lanes always come back empty - the fixed order is what a screen renders,
 * not a guess about what is populated.
 */
import type { Session } from "@hydra/contract";
import { WORKING_STATUSES } from "./status";

export type LaneKind = "waiting" | "running" | "idle" | "assistants" | "settled";

export interface Lane {
  readonly kind: LaneKind;
  readonly sessions: readonly Session[];
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export const lanesOf = (sessions: readonly Session[]): readonly Lane[] => {
  const running = sessions.filter((session) => WORKING_STATUSES.has(session.status));
  const idle = sessions.filter((session) => session.status === "idle");
  const settled = sessions.filter((session) => session.status === "exited");

  return [
    { kind: "waiting", sessions: [] },
    { kind: "running", sessions: running },
    { kind: "idle", sessions: idle },
    { kind: "assistants", sessions: [] },
    { kind: "settled", sessions: settled },
  ];
};

export const headlineOf = (sessions: readonly Session[], now: Date): string => {
  const running = sessions.filter((session) => WORKING_STATUSES.has(session.status)).length;
  const idle = sessions.filter((session) => session.status === "idle").length;
  const settled = sessions.filter(
    (session) =>
      session.status === "exited" &&
      session.exitedAt !== null &&
      now.getTime() - Date.parse(session.exitedAt) <= SEVEN_DAYS_MS,
  ).length;

  const segments: string[] = [];
  if (running > 0) segments.push(`${String(running)} running`);
  if (idle > 0) segments.push(`${String(idle)} idle`);
  if (settled > 0) segments.push(`${String(settled)} settled this week`);

  if (segments.length > 0) return segments.join(" · ");
  // Nothing at all reads as "No sessions yet"; sessions that exist but count
  // toward nothing this sentence names (an old exit, an exit with no
  // `exitedAt`) read as merely quiet rather than as if there were none.
  return sessions.length === 0 ? "No sessions yet" : "Nothing active this week";
};
