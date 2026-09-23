import { useState, type JSX, type ReactNode } from "react";
import type { ComposerPick, LoginTarget, ModelMenu, ModelPill } from "@hercule/client-core";
import { PillLabel } from "./controls";
import { ModelList } from "./model-list";
import { SelectorShell } from "./selector-shell";

/**
 * The model selector: the pill, a filter when there are enough models to need
 * one, and the list of models.
 *
 * The composer owns the filter text and clears it when this menu closes. This
 * component owns whether the older models are expanded, and collapses them
 * again when the menu closes.
 */
export function ModelSelector({
  menu,
  filter,
  onFilter,
  pill,
  disabled,
  open,
  onOpenChange,
  onPick,
  loginSlot,
}: {
  /** The model list; null while the menu is closed, because it is built only when open. */
  readonly menu: ModelMenu | null;
  readonly filter: string;
  readonly onFilter: (filter: string) => void;
  readonly pill: ModelPill;
  readonly disabled: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPick: (...steps: readonly ComposerPick[]) => void;
  readonly loginSlot: (login: LoginTarget, className: string) => ReactNode;
}): JSX.Element {
  const [older, setOlder] = useState(false);
  const pick = (...steps: readonly ComposerPick[]): void => {
    onPick(...steps);
    onOpenChange(false);
  };

  return (
    <SelectorShell
      label={<PillLabel pill={pill} />}
      className="max-w-[220px] gap-1.5 rounded-full border border-line bg-surface py-1 pr-[11px] pl-[9px] text-ink hover:bg-surface aria-expanded:border-faint aria-expanded:bg-surface [&_svg]:opacity-80"
      disabled={disabled}
      open={open}
      onOpenChange={(next) => {
        if (!next) setOlder(false);
        onOpenChange(next);
      }}
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
            older={older}
            onOlder={() => {
              setOlder(true);
            }}
            // Each row belongs to an account, so picking a row found through
            // the filter or Recent switches the account and the model together.
            onPickModel={(instanceId, model) => {
              pick({ kind: "instanceId", value: instanceId }, { kind: "model", value: model });
            }}
            onPickInstance={(instanceId) => {
              pick({ kind: "instanceId", value: instanceId });
            }}
            loginSlot={loginSlot}
          />
        </>
      )}
    </SelectorShell>
  );
}
