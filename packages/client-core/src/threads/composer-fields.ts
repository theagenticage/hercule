/**
 * Every lock, blocker and pill part the composer shows, decided in one place.
 * A thread's placement is copied at spawn and never read through afterwards
 * (spec 02 §Session), so once a thread is active its access mode, workspace
 * and machine are facts rather than fields - only the model and its options
 * stay live, and they stay live inside the instance the thread started in.
 */
import type { CapabilitySnapshot, ModelOption, ProviderInstance, Runner } from "@hydra/contract";
import { accountName, snapshotOn } from "./catalog";
import type { ThreadCatalogs, ThreadConfig, ThreadKind, ThreadPicks } from "./config";
import { referenceRunner } from "./runner-menu";

export interface ComposerField {
  /** Why this cannot be changed here, as the sentence the tooltip reads. */
  readonly locked: string | null;
}

/** The provider mark, the account where it is worth naming, and the model. */
export interface ModelPill {
  readonly providerId: string | null;
  readonly account: string | null;
  readonly name: string | null;
}

/** What a Log in would log in to: the account, the machine, and its name. */
export interface LoginTarget {
  readonly instanceId: string;
  readonly runnerId: string;
  /** What to call it while logging in, since the caller may be on another row. */
  readonly displayName: string;
}

export interface ComposerBlocked {
  readonly reason: string;
  /** The login that would clear it, where logging in is what is missing. */
  readonly login: LoginTarget | null;
}

export interface ComposerFields {
  readonly accessMode: ComposerField;
  readonly model: ComposerField & { readonly pill: ModelPill };
  /** What the current model offers to pick under it; none means no selector. */
  readonly options: readonly ModelOption[] | null;
  readonly workspace: ComposerField;
  /** The machine, named: the one in force, or that there is none to name. */
  readonly machine: ComposerField & { readonly label: string };
  /** Why this draft cannot start at all; null once it can, and on a thread that has. */
  readonly blocked: ComposerBlocked | null;
}

/**
 * Why a draft cannot start, in the order the user can act on: something to
 * run it with, a machine to run it on, then a login on that machine. Only the
 * last of the three is something a button can fix from here.
 */
const blockerOf = (
  instance: ProviderInstance | undefined,
  runner: Runner | undefined,
  snapshot: CapabilitySnapshot | undefined,
): ComposerBlocked | null => {
  if (instance === undefined) return { reason: "no provider instance is set up", login: null };
  if (runner === undefined) return { reason: "no machine is connected", login: null };
  if (snapshot === undefined)
    return { reason: `${instance.displayName} is not on ${runner.name}`, login: null };
  if (snapshot.auth.status !== "ok")
    return {
      reason: `${instance.displayName} is on ${runner.name} but not logged in`,
      login: { instanceId: instance.id, runnerId: runner.id, displayName: instance.displayName },
    };
  return null;
};

const lockedReason = (kind: ThreadKind, field: string): string | null =>
  kind === "active" ? `Create a new thread to change the ${field}` : null;

export const composerFields = (
  catalogs: ThreadCatalogs,
  config: ThreadConfig,
  kind: ThreadKind,
): ComposerFields => {
  const instance = catalogs.instances.find((each) => each.id === config.instanceId);
  const runner = referenceRunner(catalogs.runners, config.runnerId, catalogs.localRunnerId);
  const snapshot = instance === undefined ? undefined : snapshotOn(instance, runner?.id);
  const descriptor = snapshot?.models.find((model) => model.slug === config.model);

  const blocked = kind === "active" ? null : blockerOf(instance, runner, snapshot);

  return {
    accessMode: { locked: lockedReason(kind, "access mode") },
    model: {
      locked: null,
      pill: {
        providerId: instance?.providerId ?? null,
        account: instance === undefined ? null : accountName(catalogs.instances, instance),
        // A slug the snapshot no longer offers is still what the thread runs
        // under, so the pill names it rather than going blank.
        name: descriptor?.name ?? config.model,
      },
    },
    options:
      descriptor === undefined || descriptor.options.length === 0 ? null : descriptor.options,
    workspace: { locked: lockedReason(kind, "workspace") },
    machine: { locked: lockedReason(kind, "machine"), label: runner?.name ?? "no machine" },
    blocked,
  };
};

/**
 * What the card says between a model pick and the submission that carries it.
 * A pick does not reach the session on its own (spec 14 §What locks at start:
 * the picks ride `session.input`), so the thread still runs the model it
 * started this turn with until the next message goes out.
 */
export const pendingModelNote = (kind: ThreadKind, picks: ThreadPicks): string | null =>
  kind === "active" && picks.model !== undefined ? "model change applies on send" : null;
