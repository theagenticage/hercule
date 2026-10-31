/**
 * What the user chose in the composer, and how a choice is recorded.
 *
 * The picks (`ThreadPicks`) hold intent: only what the user chose, never a
 * default and never something the catalogs derived. A pick stays while the
 * current account, runner or model cannot honour it, and applies again when
 * it can. `resolveThreadConfig` is the one place that decides what applies.
 */
import type { AccessMode } from "@hercule/contract";
import type { ThreadPicks } from "./config";
import type { WorkspacePick } from "./workspaces";

/** One selector choice. A menu row emits exactly one choice. */
export type ThreadChoice =
  /**
   * A model row. It carries the entry it stands for: its account, the harness
   * the entry runs in and the model. The harness is part of the entry, because
   * a profile may offer one model in two harnesses.
   */
  | {
      readonly kind: "model";
      readonly providerAccountId: string;
      readonly harnessId: string;
      readonly model: string;
    }
  | { readonly kind: "runner"; readonly runnerId: string }
  | { readonly kind: "workspace"; readonly workspace: WorkspacePick }
  | { readonly kind: "option"; readonly id: string; readonly value: string | boolean }
  | { readonly kind: "accessMode"; readonly value: AccessMode };

/**
 * Returns `picks` with `choice` recorded. It reads no catalog, so it never
 * decides whether the choice can apply.
 *
 * - A model choice sets the account, the harness and the model together.
 * - An option choice merges into the picked options. A `false` is a choice
 *   too, so it is kept.
 * - The other choices set their field.
 */
export const applyThreadChoice = (picks: ThreadPicks, choice: ThreadChoice): ThreadPicks => {
  switch (choice.kind) {
    case "model":
      return {
        ...picks,
        providerAccountId: choice.providerAccountId,
        harnessId: choice.harnessId,
        model: choice.model,
      };
    case "runner":
      return { ...picks, runnerId: choice.runnerId };
    case "workspace":
      return { ...picks, workspace: choice.workspace };
    case "option":
      return { ...picks, options: { ...picks.options, [choice.id]: choice.value } };
    case "accessMode":
      return { ...picks, accessMode: choice.value };
  }
};
