import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * The port through which `ProviderAccountService` reports that an account's
 * default harness changed. The workflows domain listens, because the default
 * is the harness of every Agent that has none of its own, so a stored
 * workflow whose agent step asks for a structured result may stop validating
 * or start validating again. It is declared here and implemented in the
 * controller daemon, because the workflows domain depends on this one.
 *
 * It is called after the change has committed, so it never fails: the
 * implementation logs its own failure.
 */
export class ProviderAccountObserver extends Context.Service<
  ProviderAccountObserver,
  {
    /** Reports that an account's default harness changed. */
    readonly defaultHarnessChanged: () => Effect.Effect<void>;
  }
>()("hercule/controller/provider-accounts/ProviderAccountObserver") {}
