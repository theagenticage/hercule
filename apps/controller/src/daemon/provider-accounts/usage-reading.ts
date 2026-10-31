/**
 * The loop that keeps Account Usage and credential expiry current for the
 * accounts nobody is running a session for (spec 06 section 18).
 *
 * Every tick it warns about credentials that are about to expire, then reads
 * the usage of each account whose kind asks for an active read:
 *
 * - `endpoint`: the controller asks the provider, with the account's key.
 * - `harness`: the controller probes the account on a runner that can run it
 *   and asks the probe for usage.
 *
 * A read only happens when `AccountUsage.claimRead` grants it. That keeps an
 * account to one active read per 15 minutes, and none while a running session
 * reports the usage for free. The loop ticks far more often than that. The
 * claim, not the tick, is the rate limit.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import {
  ProviderAccountRunners,
  ProviderAccountService,
  type UsageRead,
} from "../../provider-accounts";
import { PromotionState } from "../../promotion";
import { AccountUsage } from "../../usage";
import { absorbFailures } from "../absorbing";
import { ProviderAccountProbing } from "./probing";

/**
 * How often the loop looks for reads that are due. A new account, or a
 * runner that just signed in, is read within a minute of the 15-minute rule
 * allowing it.
 */
const USAGE_READING_INTERVAL: Duration.Duration = Duration.minutes(1);

/** The time between ticks of the usage loop. Tests override it with a shorter one. */
export const AccountUsageReadingInterval = Context.Reference<Duration.Duration>(
  "hercule/controller/daemon/AccountUsageReadingInterval",
  { defaultValue: (): Duration.Duration => USAGE_READING_INTERVAL },
);

/**
 * Runs the usage loop: one tick at once, then one every
 * `AccountUsageReadingInterval` after the previous tick ended. Never returns.
 *
 * A tick ends when all its reads end, so a slow read delays the next tick
 * and ticks never overlap. Each read logs its own failure, so one account's
 * failure does not stop the others or the loop.
 */
export const runAccountUsageReadingLoop: Effect.Effect<
  never,
  never,
  | AccountUsage
  | ProviderAccountProbing
  | ProviderAccountRunners
  | ProviderAccountService
  | PromotionState
> = Effect.gen(function* () {
  const accountUsage = yield* AccountUsage;
  const probing = yield* ProviderAccountProbing;
  const runners = yield* ProviderAccountRunners;
  const providerAccounts = yield* ProviderAccountService;
  const promotion = yield* PromotionState;
  const interval = yield* AccountUsageReadingInterval;

  /**
   * Reads one account's usage if the claim allows it. The endpoint read
   * writes, so all of it waits for the promotion gate (its request is bounded
   * by a timeout). The harness read is claimed and gated inside `probing`.
   */
  const read = (due: UsageRead) =>
    due._tag === "endpoint"
      ? promotion.whenServing(
          Effect.flatMap(accountUsage.claimRead(due.providerAccountId), (claimed) =>
            claimed ? providerAccounts.readUsageWithKey(due.providerAccountId) : Effect.void,
          ),
        )
      : Effect.asVoid(probing.readUsageByProbe(due.runnerId, due.providerAccountId, due.harnessId));

  while (true) {
    yield* absorbFailures(
      "Warning about expiring provider account credentials failed",
      promotion.whenServing(providerAccounts.notifyExpiring()),
    );
    yield* absorbFailures(
      "Listing the provider account usage reads that are due failed",
      Effect.flatMap(runners.listUsageReads(), (due) =>
        Effect.forEach(
          due,
          (one) =>
            absorbFailures(
              `Reading the usage of provider account ${one.providerAccountId} failed`,
              read(one),
            ),
          { concurrency: "unbounded", discard: true },
        ),
      ),
    );
    yield* Effect.sleep(interval);
  }
});
