import type { JSX } from "react";
import { Checkbox, ListRow, SegmentedControl, SegmentedControlItem } from "@hydra/ui";
import type { HydraClient, ModelMenuGroup } from "@hydra/client-core";
import type { ModelOption } from "@hydra/contract";
import { ProviderLogin } from "../provider-login";
import { MenuRow } from "./menu-row";

/**
 * The model popover: `modelMenu`'s groups, each collapsed group a single
 * clickable summary row and each expanded group's models their own rows,
 * then the current model's options rendered straight off its descriptor - a
 * `select` option as a segmented row, a `boolean` one as a checkbox, no
 * free-text entry anywhere. A group already dimmed by `modelMenu` itself, or
 * forced dimmed by the caller once a thread has started, is never clickable.
 *
 * The expanded group's own dimmed reason (not logged in on this runner, or
 * found nowhere yet) shows the same way a collapsed group's does, spec 14's
 * `found, not logged in · Log in`; `Log in` opens the app's own login flow on
 * `loginRunner` when there is one to log in on, else it is plain text.
 */
export function ModelMenuContent({
  groups,
  onPickModel,
  onSwitchInstance,
  options,
  selectedOptions,
  onOptionChange,
  client,
  loginRunner,
  onLoggedIn,
}: {
  readonly groups: readonly ModelMenuGroup[];
  readonly onPickModel: (slug: string) => void;
  readonly onSwitchInstance: (instanceId: string) => void;
  /** The currently selected model's own option descriptors, verbatim. */
  readonly options: readonly ModelOption[];
  readonly selectedOptions: Readonly<Record<string, string | boolean>>;
  readonly onOptionChange: (id: string, value: string | boolean) => void;
  readonly client: HydraClient;
  /** The machine a "Log in" logs in on; absent when there is no runner to log in on at all. */
  readonly loginRunner: { readonly id: string; readonly name: string } | undefined;
  readonly onLoggedIn: () => void;
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
                {group.dimmed !== null ? (
                  <div className="flex items-center gap-1 truncate">
                    <span>{group.dimmed}</span>
                    <span>·</span>
                    {loginRunner === undefined ? (
                      <span>Log in</span>
                    ) : (
                      <ProviderLogin
                        client={client}
                        instanceId={group.instanceId}
                        runnerId={loginRunner.id}
                        subject={`${group.displayName} on ${loginRunner.name}`}
                        label="Log in"
                        variant="quiet"
                        onLoggedIn={onLoggedIn}
                      />
                    )}
                  </div>
                ) : group.identity === null && group.planLabel === null ? null : (
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
          {options.map((option) =>
            option.kind === "select" ? (
              <div key={option.id} className="flex flex-col gap-1">
                <span className="text-fine text-faint">{option.label}</span>
                <SegmentedControl
                  aria-label={option.label}
                  value={String(selectedOptions[option.id] ?? option.default)}
                  onValueChange={(value) => onOptionChange(option.id, value)}
                >
                  {(option.choices ?? []).map((choice) => (
                    <SegmentedControlItem key={choice.value} value={choice.value}>
                      {choice.label}
                    </SegmentedControlItem>
                  ))}
                </SegmentedControl>
              </div>
            ) : (
              // A boolean's own label is the checkbox's label - a heading above
              // it would say the same word twice.
              <Checkbox
                key={option.id}
                label={option.label}
                checked={Boolean(selectedOptions[option.id] ?? option.default)}
                onChange={(event) => onOptionChange(option.id, event.target.checked)}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}
