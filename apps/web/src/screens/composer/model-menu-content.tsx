import type { JSX } from "react";
import { Checkbox, ListRow, SegmentedControl, SegmentedControlItem } from "@hydra/ui";
import type { ModelMenuGroup } from "@hydra/client-core";
import type { ModelOption } from "@hydra/contract";
import { MenuRow } from "./menu-row";

/**
 * The model popover: `modelMenu`'s groups, each collapsed group a single
 * clickable summary row and each expanded group's models their own rows,
 * then the current model's options rendered straight off its descriptor - a
 * `select` option as a segmented row, a `boolean` one as a checkbox, no
 * free-text entry anywhere. A group already dimmed by `modelMenu` itself, or
 * forced dimmed by the caller once a thread has started, is never clickable.
 *
 * `onOptionChange` absent means the options are read-only: a started thread
 * has no way to change one in this build, so its own current values are
 * shown but cannot be picked.
 */
export function ModelMenuContent({
  groups,
  onPickModel,
  onSwitchInstance,
  options,
  selectedOptions,
  onOptionChange,
}: {
  readonly groups: readonly ModelMenuGroup[];
  readonly onPickModel: (slug: string) => void;
  readonly onSwitchInstance: (instanceId: string) => void;
  /** The currently selected model's own option descriptors, verbatim. */
  readonly options: readonly ModelOption[];
  readonly selectedOptions: Readonly<Record<string, string | boolean>>;
  readonly onOptionChange?: ((id: string, value: string | boolean) => void) | undefined;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        {groups.map((group) =>
          group.expanded ? (
            <div key={group.instanceId} className="flex flex-col gap-0.5">
              <div className="px-2.5 py-1 text-fine text-faint">
                <div className="truncate text-ink">
                  {group.displayName} · {group.name}
                </div>
                {group.identity === null && group.planLabel === null ? null : (
                  <div className="truncate">
                    {group.identity}{" "}
                    {group.identity !== null && group.planLabel !== null ? "· " : ""}
                    {group.planLabel}
                  </div>
                )}
              </div>
              {group.models.map((model) => (
                <MenuRow
                  key={model.slug}
                  label={model.name}
                  selected={model.current}
                  dimmed={model.dimmed}
                  onClick={() => onPickModel(model.slug)}
                />
              ))}
            </div>
          ) : (
            <ListRow
              key={group.instanceId}
              dimmed={group.dimmed !== null}
              disabled={group.dimmed !== null}
              onClick={() => onSwitchInstance(group.instanceId)}
            >
              <span className="flex min-w-0 flex-1 flex-col text-fine">
                <span className="truncate text-row text-ink">
                  {group.displayName} · {group.name}
                </span>
                <span className="truncate text-faint">
                  {group.dimmed ??
                    [group.identity, group.planLabel].filter((each) => each !== null).join(" · ")}
                </span>
                <span className="text-faint">{group.models.length} models</span>
              </span>
            </ListRow>
          ),
        )}
      </div>
      {options.length === 0 ? null : (
        <div className="flex flex-col gap-2 border-t border-line-soft pt-2">
          {options.map((option) => (
            <div key={option.id} className="flex flex-col gap-1">
              <span className="text-fine text-faint">{option.label}</span>
              {option.kind === "select" ? (
                <SegmentedControl
                  aria-label={option.label}
                  value={String(selectedOptions[option.id] ?? option.default)}
                  onValueChange={(value) => onOptionChange?.(option.id, value)}
                >
                  {(option.choices ?? []).map((choice) => (
                    <SegmentedControlItem
                      key={choice.value}
                      value={choice.value}
                      disabled={onOptionChange === undefined}
                    >
                      {choice.label}
                    </SegmentedControlItem>
                  ))}
                </SegmentedControl>
              ) : (
                <Checkbox
                  label={option.label}
                  checked={Boolean(selectedOptions[option.id] ?? option.default)}
                  disabled={onOptionChange === undefined}
                  onChange={(event) => onOptionChange?.(option.id, event.target.checked)}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
