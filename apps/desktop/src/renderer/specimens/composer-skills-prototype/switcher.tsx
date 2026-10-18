/**
 * PROTOTYPE (#766). The floating switcher: the scene with ← and → or its
 * menu, and the theme. Drawn in plain black and white so it is never
 * mistaken for the design. ← and → are ignored while typing.
 */
import { useCallback, useEffect, type JSX } from "react";
import { SCENES } from "./scenes";
import {
  openScene,
  readSceneKey,
  THEMES,
  updateTheme,
  useTheme,
  type Theme,
} from "./prototype-state";

/** Checks whether a key press lands in a field, where ← and → move the caret. */
const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.matches("input, textarea, select") || target.isContentEditable);

/** Renders the switcher, fixed to the bottom of the window. Picking a scene loads its address. */
export function Switcher(): JSX.Element {
  const theme = useTheme();
  const scene = readSceneKey();
  const index = Math.max(
    0,
    SCENES.findIndex((each) => each.key === scene),
  );
  const step = useCallback(
    (by: number): void => {
      openScene(SCENES[(index + by + SCENES.length) % SCENES.length]!.key);
    },
    [index],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (isTyping(event.target) || event.metaKey || event.altKey || event.ctrlKey) return;
      if (event.key === "ArrowLeft") step(-1);
      if (event.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step]);

  return (
    <div className="proto-switcher" role="toolbar" aria-label="Prototype switcher">
      <button type="button" onClick={() => step(-1)} aria-label="Previous scene">
        ←
      </button>
      <select
        aria-label="Scene"
        value={SCENES[index]!.key}
        onChange={(event) => openScene(event.target.value)}
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
        onChange={(event) => updateTheme(event.target.value as Theme)}
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
