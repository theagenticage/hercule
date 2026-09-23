/**
 * Reads a provider instance's catalog. A catalog belongs to one instance on
 * one runner (spec 06 §3.1), so every function here takes the runner the
 * thread is placed on: the same instance can offer a model list on one runner
 * and nothing at all on another.
 */
import type { CapabilitySnapshot, ProviderInstance, Runner } from "@hercule/contract";

/**
 * Returns the instance's capability snapshot on a runner, or `undefined` when
 * it has none there.
 */
export const findSnapshotOn = (
  instance: ProviderInstance,
  runnerId: string | undefined,
): CapabilitySnapshot | undefined =>
  instance.snapshots.find((snapshot) => snapshot.runnerId === runnerId);

/**
 * Returns the instance's account name when another instance has the same
 * provider, or `null` when it is the only one. A single account does not need
 * a name to tell it apart.
 */
export const findAccountName = (
  instances: readonly ProviderInstance[],
  instance: ProviderInstance,
): string | null =>
  instances.filter((each) => each.providerId === instance.providerId).length > 1
    ? instance.name
    : null;

/**
 * Returns the label for an instance in a menu: its account name if it needs
 * one, else the provider's display name.
 */
export const buildInstanceLabel = (
  instances: readonly ProviderInstance[],
  instance: ProviderInstance,
): string => findAccountName(instances, instance) ?? instance.displayName;

/**
 * What a "Log in" action logs in to: the instance, the runner, and a label for
 * the pair. The runner is needed because a credential is stored on one runner
 * only, and the caller may be showing a different row.
 */
export interface LoginTarget {
  readonly instanceId: string;
  readonly runnerId: string;
  /** What the login is for, in full: `Claude Code on atlas`. */
  readonly subject: string;
}

export const buildLoginTarget = (instance: ProviderInstance, runner: Runner): LoginTarget => ({
  instanceId: instance.id,
  runnerId: runner.id,
  subject: `${instance.displayName} on ${runner.name}`,
});
