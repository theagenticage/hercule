import type { JSX, ReactNode } from "react";
import type {
  ModelMenu,
  ModelPill,
  NewModelRow,
  SignInTarget,
  ThreadChoice,
} from "@hercule/client-core";
import { PillLabel } from "./controls";
import { ModelList, type NewModelRefusal } from "./model-list";
import { SelectorShell } from "./selector-shell";

/**
 * The model selector: the pill, a filter when there are enough models to need
 * one, and the list of models.
 *
 * The composer owns the filter text and clears it when this menu closes.
 */
export function ModelSelector({
  menu,
  filter,
  onFilter,
  onOpenProfile,
  onAddNewModel,
  onDismissNewModel,
  savingNewModel,
  newModelRefusal,
  pill,
  disabled,
  open,
  onOpenChange,
  onChoose,
  renderProviderMark,
  signInSlot,
}: {
  /** The model list; null while the menu is closed, because it is built only when open. */
  readonly menu: ModelMenu | null;
  readonly filter: string;
  readonly onFilter: (filter: string) => void;
  /** Unfolds the profile whose head the user clicked, which folds the one that was open. */
  readonly onOpenProfile: (profileId: string) => void;
  /** Adds a New row's model to the profile whose lane holds the row. The menu stays open. */
  readonly onAddNewModel: (profileId: string, row: NewModelRow) => void;
  /** Hides a New row's model in the profile whose lane holds the row. The menu stays open. */
  readonly onDismissNewModel: (profileId: string, row: NewModelRow) => void;
  readonly savingNewModel: boolean;
  readonly newModelRefusal: NewModelRefusal | null;
  readonly pill: ModelPill;
  readonly disabled: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onChoose: (choice: ThreadChoice) => void;
  readonly renderProviderMark: (providerId: string) => ReactNode;
  readonly signInSlot: (target: SignInTarget, className: string) => ReactNode;
}): JSX.Element {
  const forwardThreadChoice = (choice: ThreadChoice): void => {
    onChoose(choice);
    onOpenChange(false);
  };

  return (
    <SelectorShell
      label={<PillLabel pill={pill} />}
      className="max-w-[220px] gap-1.5 rounded-full border border-line bg-surface py-1 pr-[11px] pl-[9px] text-ink hover:bg-surface aria-expanded:border-faint aria-expanded:bg-surface [&_svg]:opacity-80"
      disabled={disabled}
      open={open}
      onOpenChange={onOpenChange}
      align="end"
      contentClassName="w-[360px]"
    >
      {menu === null ? null : (
        <>
          {menu.filterable ? (
            <input
              autoFocus
              value={filter}
              placeholder="Filter models…"
              onChange={(event) => {
                onFilter(event.target.value);
              }}
              className="mx-0.5 mt-0.5 mb-1 rounded-[6px] border border-line bg-surface px-[9px] py-[5px] text-meta text-ink outline-none placeholder:text-faint focus:border-live"
            />
          ) : null}
          <ModelList
            menu={menu}
            renderProviderMark={renderProviderMark}
            onChoose={forwardThreadChoice}
            onOpenProfile={onOpenProfile}
            onAddNewModel={onAddNewModel}
            onDismissNewModel={onDismissNewModel}
            savingNewModel={savingNewModel}
            newModelRefusal={newModelRefusal}
            signInSlot={signInSlot}
          />
        </>
      )}
    </SelectorShell>
  );
}
