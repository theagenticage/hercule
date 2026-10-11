import type { JSX, KeyboardEvent } from "react";

/** One segment of a `ViewSwitch`: the view it picks and the words on its button. */
export interface ViewChoice<View extends string> {
  readonly view: View;
  readonly label: string;
}

/**
 * Renders a `.seg` switch between two views, such as the Runs tab's List and
 * Timeline, as a group named `label`. The button of `view` is pressed, and
 * pressing the other calls `onPick` with its view. ← and → pick the first
 * or the second view and move focus to its button, as a segmented control on
 * the Mac does.
 */
export function ViewSwitch<View extends string>({
  label,
  choices,
  view,
  onPick,
}: {
  readonly label: string;
  readonly choices: readonly [ViewChoice<View>, ViewChoice<View>];
  readonly view: View;
  readonly onPick: (view: View) => void;
}): JSX.Element {
  const pickWithArrow = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = event.key === "ArrowLeft" ? choices[0] : choices[1];
    if (next.view !== view) onPick(next.view);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-view="${next.view}"]`)?.focus();
  };
  return (
    <div className="seg" role="group" aria-label={label} onKeyDown={pickWithArrow}>
      {choices.map((each) => (
        <button
          key={each.view}
          type="button"
          data-view={each.view}
          aria-pressed={each.view === view}
          onClick={() => {
            if (each.view !== view) onPick(each.view);
          }}
        >
          {each.label}
        </button>
      ))}
    </div>
  );
}
