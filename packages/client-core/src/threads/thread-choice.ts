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
  /** A model row. It always carries its account, because a model belongs to one account. */
  | { readonly kind: "model"; readonly providerAccountId: string; readonly model: string }
  /** An account row that has no model to pick. */
  | { readonly kind: "account"; readonly providerAccountId: string }
  | { readonly kind: "runner"; readonly runnerId: string }
  | { readonly kind: "workspace"; readonly workspace: WorkspacePick }
  | { readonly kind: "option"; readonly id: string; readonly value: string | boolean }
  | { readonly kind: "accessMode"; readonly value: AccessMode };

/**
 * Returns `picks` with `choice` recorded. It reads no catalog, so it never
 * decides whether the choice can apply.
 *
 * - A model choice sets the account and the model.
 * - An account choice sets the account and removes the model pick, because
 *   the model belonged to the account that offered it. The account's default
 *   model applies instead.
 * - An option choice merges into the picked options. A `false` is a choice
 *   too, so it is kept.
 * - The other choices set their field.
 */
export const applyThreadChoice = (picks: ThreadPicks, choice: ThreadChoice): ThreadPicks => {
  switch (choice.kind) {
    case "model":
      return { ...picks, providerAccountId: choice.providerAccountId, model: choice.model };
    case "account":
      return {
        ...Object.fromEntries(Object.entries(picks).filter(([key]) => key !== "model")),
        providerAccountId: choice.providerAccountId,
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
