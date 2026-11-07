import { useLayoutEffect, useRef, type JSX } from "react";
import { animateValue, type MotionValue } from "../../app/motion";
import { ViewSwitch, type ViewChoice } from "../view-switch";
import "./view-pill.css";

/** The puck's left edge and width, as two numbers on springs. */
interface Puck {
  readonly left: MotionValue;
  readonly width: MotionValue;
}

/**
 * Renders the view pill: a floating glass pill that names the place with
 * `title`, such as "Overview", and then holds its views as tabs of words, with
 * no icons. The selected tab sits on a puck that slides to the tab picked,
 * and changes its width, on the `hand` spring.
 *
 * - `choices` are the tabs, left to right, as data, so a page with three
 *   views draws three. `view` is the selected one and `onPick` receives the
 *   view a press or an arrow key picks (`ViewSwitch` handles the keys).
 * - `label` names the group of tabs for assistive technology.
 *
 * The pill reads nothing and knows no route: the caller changes the view,
 * and the shortcuts that pick one, such as ⌘1 and ⌘2, are the caller's too.
 */
export function ViewPill<View extends string>({
  title,
  label,
  choices,
  view,
  onPick,
}: {
  readonly title: string;
  readonly label: string;
  readonly choices: ReadonlyArray<ViewChoice<View>>;
  readonly view: View;
  readonly onPick: (view: View) => void;
}): JSX.Element {
  const tabsRef = useRef<HTMLDivElement>(null);
  const puckRef = useRef<HTMLElement>(null);
  const puck = useRef<Puck | null>(null);

  // The puck goes to the selected tab. The first time it is put there at once,
  // and afterwards it slides from where it is, even from the middle of a slide.
  useLayoutEffect(() => {
    const selected = tabsRef.current?.querySelector<HTMLElement>(`[data-view="${view}"]`);
    const element = puckRef.current;
    if (selected === null || selected === undefined || element === null) return;
    const { offsetLeft, offsetWidth } = selected;
    if (puck.current === null) {
      puck.current = {
        left: animateValue(offsetLeft, (left) => {
          element.style.transform = `translateX(${left}px)`;
        }),
        width: animateValue(offsetWidth, (width) => {
          element.style.width = `${width}px`;
        }),
      };
      puck.current.left.set(offsetLeft);
      puck.current.width.set(offsetWidth);
      return;
    }
    puck.current.left.to(offsetLeft, "hand");
    puck.current.width.to(offsetWidth, "hand");
  }, [view, choices]);

  return (
    <div className="pill">
      <h1 className="pill-title">{title}</h1>
      <div className="view-tabs" ref={tabsRef}>
        <i className="view-tabs-puck" ref={puckRef} />
        <ViewSwitch
          className="view-tabs-group"
          label={label}
          choices={choices}
          view={view}
          onPick={onPick}
        />
      </div>
    </div>
  );
}
