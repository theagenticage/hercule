import { useId, type JSX, type ReactNode } from "react";
import type { SignInRunnerOption } from "@hercule/client-core";
import { ChevronRightIcon } from "../../../icons/chevron-right";
import "./add-provider-account-sheet.css";

/** One provider in the add-account sheet's first step. */
export interface ProviderTile {
  readonly id: string;
  readonly name: string;
  /** The provider's mark, drawn in a sunken square before its name. */
  readonly mark: ReactNode;
}

/**
 * Renders one button for each provider: its mark, its name and a chevron. Pressing
 * one calls `onPick` with the provider's id. The first one is where the
 * sheet puts the focus.
 */
export function ProviderTiles({
  providers,
  onPick,
}: {
  readonly providers: ReadonlyArray<ProviderTile>;
  readonly onPick: (providerId: string) => void;
}): JSX.Element {
  return (
    <div className="aa-providers">
      {providers.map((provider, index) => (
        <button
          key={provider.id}
          type="button"
          className="aa-provider"
          data-initial-focus={index === 0 ? "" : undefined}
          onClick={() => onPick(provider.id)}
        >
          <span className="aa-mark">{provider.mark}</span>
          <b>{provider.name}</b>
          <ChevronRightIcon size={14} />
        </button>
      ))}
    </div>
  );
}

/** One kind of account at the chosen provider, as the user picks it. */
export interface AccountKindChoice {
  readonly id: string;
  /** The kind's title, such as "Claude subscription, every machine". */
  readonly title: string;
  readonly description: string;
}

/**
 * Renders one radio card for each kind, with its title and description, and
 * `pickedId` on. `onPick` is called with the id of the kind the user picks.
 */
export function AccountKindCards({
  kinds,
  pickedId,
  onPick,
}: {
  readonly kinds: ReadonlyArray<AccountKindChoice>;
  readonly pickedId: string | null;
  readonly onPick: (kindId: string) => void;
}): JSX.Element {
  const group = useId();
  return (
    <div className="aa-cards" role="radiogroup" aria-label="Kind of account">
      {kinds.map((kind, index) => (
        <label key={kind.id} className="aa-card">
          <span className="choice-box">
            <input
              type="radio"
              name={group}
              value={kind.id}
              data-initial-focus={
                kind.id === pickedId || (pickedId === null && index === 0) ? "" : undefined
              }
              checked={kind.id === pickedId}
              onChange={() => onPick(kind.id)}
            />
          </span>
          <b>{kind.title}</b>
          <small>{kind.description}</small>
        </label>
      ))}
    </div>
  );
}

/**
 * Renders one radio card for each machine the sign-in can run on, in the
 * order given, with `chosenRunnerId` on. A machine that can do nothing now
 * (offline, or a Hercule build that cannot run the harness) is dimmed with its
 * reason under its name, and cannot be picked. The machine that runs the
 * controller says so under its name. `onChoose` is called with the id of the
 * machine the user picks.
 */
export function RunnerCards({
  options,
  chosenRunnerId,
  onChoose,
}: {
  readonly options: ReadonlyArray<SignInRunnerOption>;
  readonly chosenRunnerId: string | null;
  readonly onChoose: (runnerId: string) => void;
}): JSX.Element {
  const group = useId();
  return (
    <div className="aa-cards" role="radiogroup" aria-label="Machine">
      {options.map((option) => {
        const reason = option.action.reason;
        const note = reason ?? (option.isController ? "Runs Hercule" : null);
        return (
          <label key={option.runnerId} className={reason === null ? "aa-card" : "aa-card is-off"}>
            <span className="choice-box">
              <input
                type="radio"
                name={group}
                value={option.runnerId}
                data-initial-focus={option.runnerId === chosenRunnerId ? "" : undefined}
                checked={option.runnerId === chosenRunnerId}
                disabled={reason !== null}
                onChange={() => onChoose(option.runnerId)}
              />
            </span>
            <b>{option.runnerName}</b>
            {note !== null && <small>{note}</small>}
          </label>
        );
      })}
    </div>
  );
}
