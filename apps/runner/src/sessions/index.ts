/**
 * Hosts sessions on this runner: turns the controller's start frame into
 * paths and an environment on this machine, and supervises the sessions it
 * starts (spec 06 sections 4.2 and 9.1).
 */
import { adapters } from "../providers";
import { makeSupervising } from "./supervisor";

export type { Machine } from "./context";
export type { Connection, SessionSupervisor, Supervising } from "./supervisor";

/**
 * Created once per process, not once per connection, because this runner's
 * sessions and their event sequence numbers outlive the socket that started
 * them.
 */
export const sessions = makeSupervising(adapters);
