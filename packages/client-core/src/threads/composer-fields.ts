/**
 * Every lock, blocker and pill part the composer shows, decided in one place.
 * A thread's placement is copied at spawn and never read through afterwards
 * (spec 02 §Session), so once a thread is active its access mode, workspace
 * and machine are facts rather than fields - only the model and its options
 * stay live, and they stay live inside the instance the thread spawned in.
 */
import type {
  AccessMode,
  CapabilitySnapshot,
  ModelOption,
  ProviderInstance,
  Runner,
} from "@hydra/contract";
import { accessModeMenu, type AccessModeMenuItem } from "./access-modes";
import { accountName, loginTarget, snapshotOn, type LoginTarget } from "./catalog";
import type { ThreadCatalogs, ThreadConfig, ThreadKind, ThreadPicks } from "./config";
import { referenceRunner, runnerMenu, type RunnerMenuRow } from "./runner-menu";

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

export interface ComposerBlocked {
  readonly reason: string;
  /** The login that would clear it, where logging in is what is missing. */
  readonly login: LoginTarget | null;
}

/** One machine the thread could be placed on, and whether it is the one in force. */
export interface MachineRow extends RunnerMenuRow {
  readonly current: boolean;
}

export interface ComposerFields {
  /** The mode in force, and the four the menu offers under it. */
  readonly accessMode: ComposerField & {
    readonly value: AccessMode;
    readonly rows: readonly AccessModeMenuItem[];
  };
  readonly model: { readonly pill: ModelPill };
  /** What the current model offers to pick under it; none means no selector. */
  readonly options: readonly ModelOption[] | null;
  readonly workspace: ComposerField;
  /** The machine: the one in force, named with why it is dimmed, and the fleet. */
  readonly machine: ComposerField & {
    readonly label: string;
    readonly rows: readonly MachineRow[];
  };
  /** The sentence a draft stands under; an active thread stands under none. */
  readonly lead: string | null;
  /** Why this draft cannot start at all; null once it can, and on a thread that has. */
  readonly blocked: ComposerBlocked | null;
}

/** What a draft says above its card while nothing stops it from starting. */
const LEAD = "It works without a checkout.";

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
      login: loginTarget(instance, runner),
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

  // The name and the reason come off one machine, never off two: a machine
  // named with another's reason would send the user to fix the wrong thing.
  const rows: readonly MachineRow[] =
    instance === undefined
      ? []
      : runnerMenu(catalogs.runners, catalogs.localRunnerId, instance).rows.map((row) => ({
          ...row,
          current: row.runnerId === runner?.id,
        }));
  const dimmed = rows.find((row) => row.current)?.dimmed ?? null;
  const name = runner?.name ?? "no machine";

  return {
    accessMode: {
      locked: lockedReason(kind, "access mode"),
      value: config.accessMode,
      rows:
        instance === undefined
          ? []
          : accessModeMenu(instance.declared.accessModes, instance.displayName),
    },
    model: {
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
    machine: {
      locked: lockedReason(kind, "machine"),
      label: dimmed === null ? name : `${name} · ${dimmed}`,
      rows,
    },
    lead: kind === "active" ? null : LEAD,
    blocked: kind === "active" ? null : blockerOf(instance, runner, snapshot),
  };
};

/**
 * What the card says between a model pick and the submission that carries it.
 * A pick does not reach the session on its own (spec 14 §What locks at start:
 * the picks ride `session.input`), so the thread still runs the model it
 * runs this turn with until the next message goes out.
 */
export const pendingModelNote = (kind: ThreadKind, picks: ThreadPicks): string | null =>
  kind === "active" && picks.model !== undefined ? "model change applies on send" : null;
