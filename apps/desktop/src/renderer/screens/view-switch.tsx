import type { JSX, KeyboardEvent, ReactNode } from "react";

/**
 * One segment of a `ViewSwitch`: the view it picks and the words on its
 * button, with a `mark` in front of them when the caller has one.
 */
export interface ViewChoice<View extends string> {
  readonly view: View;
  readonly label: string;
  readonly mark?: ReactNode;
}

/**
 * Renders a `.seg` switch between views, such as the Runs tab's List and
 * Timeline, as a group named `label`. The button of `view` is pressed, and
 * pressing another calls `onPick` with its view. ← and → pick the view before
 * or after the pressed one and move focus to its button, as a segmented
 * control on the Mac does. At either end, the arrow keeps the view.
 *
 * The group has the class `className`, `seg` unless the caller draws the
 * buttons itself.
 */
export function ViewSwitch<View extends string>({
  label,
  choices,
  view,
  onPick,
  className,
}: {
  readonly label: string;
  readonly choices: ReadonlyArray<ViewChoice<View>>;
  readonly view: View;
  readonly onPick: (view: View) => void;
  readonly className?: string;
}): JSX.Element {
  const pickWithArrow = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.key === "ArrowLeft" ? -1 : 1;
    const current = choices.findIndex((each) => each.view === view);
    const next = choices[Math.min(Math.max(current + step, 0), choices.length - 1)];
    if (next === undefined) return;
    if (next.view !== view) onPick(next.view);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-view="${next.view}"]`)?.focus();
  };
  return (
    <div className={className ?? "seg"} role="group" aria-label={label} onKeyDown={pickWithArrow}>
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
          {each.mark}
          {each.label}
        </button>
      ))}
    </div>
  );
}
