/**
 * PROTOTYPE (#731). The floating switcher: the scene with ← and → or its
 * menu, and the theme. Drawn in plain black and white so it is never
 * mistaken for the design. ← and → are ignored while typing.
 */
import { useEffect, type JSX } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  SCENES,
  THEMES,
  buildScenePath,
  updatePrototype,
  usePrototype,
  type Scene,
  type Theme,
} from "./prototype-state";

/** Checks whether a key press lands in a field, where ← and → move the caret. */
const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.matches("input, textarea, select") || target.isContentEditable);

/** Renders the switcher, fixed to the bottom of the window. Picking a scene opens its address. */
export function Switcher(): JSX.Element {
  const { scene, theme } = usePrototype();
  const navigate = useNavigate();
  const index = SCENES.findIndex((each) => each.key === scene);
  const open = (key: Scene): void => {
    updatePrototype({ scene: key });
    // The prototype's routes are not in the app's route tree, so the address is cast.
    void navigate({ to: buildScenePath(key) as never });
  };
  const step = (by: number): void => {
    open(SCENES[(index + by + SCENES.length) % SCENES.length]!.key);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (isTyping(event.target) || event.metaKey || event.altKey || event.ctrlKey) return;
      if (event.key === "ArrowLeft") step(-1);
      if (event.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="proto-switcher" role="toolbar" aria-label="Prototype switcher">
      <button type="button" onClick={() => step(-1)} aria-label="Previous scene">
        ←
      </button>
      <select
        aria-label="Scene"
        value={scene}
        onChange={(event) => open(event.target.value as Scene)}
      >
        {SCENES.map((each, at) => (
          <option key={each.key} value={each.key}>
            {`${at + 1}. ${each.name}`}
          </option>
        ))}
      </select>
      <button type="button" onClick={() => step(1)} aria-label="Next scene">
        →
      </button>
      <span className="proto-sep" />
      <select
        aria-label="Theme"
        value={theme}
        onChange={(event) => updatePrototype({ theme: event.target.value as Theme })}
      >
        {THEMES.map((each) => (
          <option key={each} value={each}>
            {each}
          </option>
        ))}
      </select>
    </div>
  );
}
