/**
 * The port through which a `core.signal-build-failed` notification counts the
 * failed builds of its signal kind when it is read.
 *
 * The count is read from the signals, and the signals domain depends on the
 * workflows domain, which raises notifications. Reading the signals from here
 * would make the domain graph a cycle, so this domain declares the one read
 * it needs, and the controller daemon implements it. ADR 0033 owns the rules
 * for breaking a cycle between domains.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";

export class SignalBuildFailures extends Context.Service<
  SignalBuildFailures,
  {
    /**
     * Counts the signals of `kind`, a qualified signal kind, raised from the
     * event `sinceEventId` or a later one and written from their event
     * because the plugin's `build` failed.
     */
    readonly countSince: (kind: string, sinceEventId: number) => Effect.Effect<number, SqlError>;
  }
>()("hercule/controller/notifications/SignalBuildFailures") {}
