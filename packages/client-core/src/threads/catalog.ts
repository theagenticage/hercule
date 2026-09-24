/**
 * Reading one instance's catalog. A catalog is scoped instance x runner (spec
 * 06 §3.1), so every reading here goes through the runner the thread is placed
 * on: the same instance offers a model list on one machine and nothing at all
 * on another.
 */
import type { CapabilitySnapshot, ProviderInstance, Runner } from "@hercule/contract";

export const findSnapshotOn = (
  instance: ProviderInstance,
  runnerId: string | undefined,
): CapabilitySnapshot | undefined =>
  instance.snapshots.find((snapshot) => snapshot.runnerId === runnerId);

/** The account name where it is worth naming at all: a lone account has no
 * other account to be told apart from, so it names nothing.
 */
export const findAccountName = (
  instances: readonly ProviderInstance[],
  instance: ProviderInstance,
): string | null =>
  instances.filter((each) => each.providerId === instance.providerId).length > 1
    ? instance.name
    : null;

/** What to call an instance where it stands for itself in a menu. */
export const buildInstanceLabel = (
  instances: readonly ProviderInstance[],
  instance: ProviderInstance,
): string => findAccountName(instances, instance) ?? instance.displayName;

/** What a Log in would log in to: the account, the machine, and what to call
 * the pair, since the caller may be on another row and a credential lands on
 * one machine only.
 */
export interface LoginTarget {
  readonly instanceId: string;
  readonly runnerId: string;
  /** What the login is for, named in full: `Claude Code on atlas`. */
  readonly subject: string;
}

export const buildLoginTarget = (instance: ProviderInstance, runner: Runner): LoginTarget => ({
  instanceId: instance.id,
  runnerId: runner.id,
  subject: `${instance.displayName} on ${runner.name}`,
});
