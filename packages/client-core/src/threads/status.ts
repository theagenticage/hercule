/**
 * The statuses a session reads as still in progress: a running turn, or
 * placement still working out where it lands. Shared because a row's mark and
 * a lane's bucket are the same question asked from two screens.
 */
import type { SessionStatus } from "@hydra/contract";

export const WORKING_STATUSES: ReadonlySet<SessionStatus> = new Set(["busy", "starting", "queued"]);
