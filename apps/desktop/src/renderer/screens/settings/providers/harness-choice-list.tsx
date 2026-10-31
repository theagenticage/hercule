import { useId, type JSX, type ReactNode } from "react";
import "./providers.css";

/** One harness in the account sheet's Default harness section. */
export interface HarnessChoice {
  readonly harnessId: string;
  readonly name: string;
  /** The harness's mark, drawn before its name. */
  readonly mark: ReactNode;
  /**
   * Why the account cannot run in the harness, such as "pi is on no machine";
   * `null` when it can. The harness is then struck through and cannot be picked.
   */
  readonly unavailableReason: string | null;
}

/**
 * Renders the Default harness section of the account sheet: one radio per
 * harness, with `selectedId` on. A harness the account cannot run in is struck
 * through, with its reason on a line under its name, and cannot be picked. It
 * keeps its radio on when it is the saved choice, so the sheet does not hide
 * that the account now points at a harness that cannot run it.
 *
 * `onPick` is called with the id of the harness the user picks. `error` is why
 * the last pick failed, shown in place of the hint under the list.
 */
export function HarnessChoiceList({
  choices,
  selectedId,
  onPick,
  error,
}: {
  readonly choices: ReadonlyArray<HarnessChoice>;
  readonly selectedId: string;
  readonly onPick: (harnessId: string) => void;
  readonly error: string | null;
}): JSX.Element {
  const group = useId();
  return (
    <div className="pa-harnesses">
      <div role="radiogroup" aria-label="Default harness">
        {choices.map((choice) => {
          const nameId = `${group}-${choice.harnessId}-name`;
          const reasonId = `${group}-${choice.harnessId}-reason`;
          const unavailable = choice.unavailableReason !== null;
          return (
            <label
              key={choice.harnessId}
              className={unavailable ? "pa-harness is-off" : "pa-harness"}
            >
              <span className="choice-box">
                <input
                  type="radio"
                  name={group}
                  value={choice.harnessId}
                  checked={choice.harnessId === selectedId}
                  disabled={unavailable}
                  aria-labelledby={nameId}
                  aria-describedby={unavailable ? reasonId : undefined}
                  onChange={() => onPick(choice.harnessId)}
                />
              </span>
              {choice.mark}
              <span className="pa-harness-text">
                <b id={nameId}>{choice.name}</b>
                {choice.unavailableReason !== null && (
                  <small id={reasonId}>{choice.unavailableReason}</small>
                )}
              </span>
            </label>
          );
        })}
      </div>
      {error === null ? (
        <p className="pa-hint">
          Every profile runs this account&rsquo;s models here, unless the account&rsquo;s line in a
          profile picks another.
        </p>
      ) : (
        <p className="fl-err" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
