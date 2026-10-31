import * as Effect from "effect/Effect";
import { announce } from "../db";

/**
 * Announces on the `provider` live topic that a runner changed in a way that
 * changes where Provider Accounts can run: it connected or disconnected, said
 * hello or reported other facts, or was drained, undrained or retired.
 *
 * An account's readiness rows and the entries of a Model Profile (whether
 * each can run now) are worked out from the runners, so a client that shows
 * them must read them again. The push names the runner, and the topic's
 * clients refetch every account and profile whichever id it names.
 *
 * Call it inside the transaction that records the change, so the announcement
 * is sent only if the change is committed.
 */
export const announceProviderRunnerChange = (runnerId: string): Effect.Effect<void> =>
  announce({ _tag: "record", topic: "provider", id: runnerId, kind: "updated" });
