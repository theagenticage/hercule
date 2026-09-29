/**
 * Returns the id of the provider instance a new thread starts on when
 * `thread.instanceId` is not set. Settings > Threads also uses it when the
 * stored id no longer matches an instance. Returns, in order of preference:
 *
 * - the first instance that is logged in on some runner;
 * - otherwise the first instance;
 * - otherwise `null`, when no instance exists.
 *
 * The composer and Settings > Threads both prefill from this rule (through
 * `computeThreadDefaults`). A logged-in instance comes first because the
 * controller never places a session on a runner where the instance is not
 * logged in (spec 06 §3.2).
 */
import type { ProviderInstance } from "@hercule/contract";

export const findDefaultInstanceId = (instances: readonly ProviderInstance[]): string | null =>
  instances.find((instance) => instance.snapshots.some((snapshot) => snapshot.auth.status === "ok"))
    ?.id ??
  instances[0]?.id ??
  null;
