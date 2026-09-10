/**
 * The instance a new thread starts on before `thread.instanceId` is set, and
 * Settings > Threads' fallback when a stored id no longer names an instance:
 * the first instance with a logged-in snapshot anywhere, else the first
 * instance, else none at all - no instance exists, which is `null`. The
 * composer and Settings > Threads both prefill from this same rule (through
 * `threadDefaults`), which is the server's own placement rule (spec 06 §3).
 */
import type { ProviderInstance } from "@hydra/contract";

export const defaultInstanceId = (instances: readonly ProviderInstance[]): string | null =>
  instances.find((instance) => instance.snapshots.some((snapshot) => snapshot.auth.status === "ok"))
    ?.id ??
  instances[0]?.id ??
  null;
