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
  | { readonly kind: "accessMode"; readonly value: AccessMode }
  /**
   * A change of the draft's own list of MCP Servers, made while the draft was
   * in `projectId` (`null` for no project). The new list is decided from the
   * draft's list at the moment the choice is recorded, so two changes made
   * before the screen draws again both count.
   * `decideMcpServerIds` receives the ids the draft's pick holds for
   * `projectId`, or `undefined` while the draft holds no pick for it. It
   * returns the new list, or `undefined` when nothing changes.
   */
  | {
      readonly kind: "mcpServers";
      readonly projectId: string | null;
      readonly decideMcpServerIds: (
        pickedIds: readonly string[] | undefined,
      ) => readonly string[] | undefined;
    }
  /**
   * Forgets the draft's own list of MCP Servers, so the draft follows the
   * list it starts from again, including later changes to that list.
   */
  | { readonly kind: "mcpServersReset" };

/**
 * Returns `picks` with `choice` recorded. It reads no catalog, so it never
 * decides whether the choice can apply.
 *
 * - A model choice sets the account, the harness and the model together.
 * - An option choice merges into the picked options. A `false` is a choice
 *   too, so it is kept.
 * - The MCP Servers choice records the list it decides from the pick held now,
 *   with the project it was made under. It records nothing when it decides no change.
 * - The MCP Servers reset removes that pick.
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
    case "mcpServers": {
      const held = picks.mcpServers;
      const mcpServerIds = choice.decideMcpServerIds(
        held?.projectId === choice.projectId ? held.mcpServerIds : undefined,
      );
      return mcpServerIds === undefined
        ? picks
        : { ...picks, mcpServers: { projectId: choice.projectId, mcpServerIds } };
    }
    case "mcpServersReset": {
      const { mcpServers, ...rest } = picks;
      return mcpServers === undefined ? picks : rest;
    }
  }
};
