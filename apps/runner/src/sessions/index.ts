/**
 * Sessions on this runner: resolving what the controller asked for to this
 * machine, and supervising what it started (spec 06 sections 4.2 and 9.1).
 */
import { adapters } from "../providers";
import { supervising } from "./supervisor";

export type { Machine } from "./context";
export type { Connection, SessionSupervisor } from "./supervisor";

/**
 * One per process, not per connection: this runner's sessions and their
 * sequence outlive the socket that started them.
 */
export const sessions = supervising(adapters);
