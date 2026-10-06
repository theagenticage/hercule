/**
 * PROTOTYPE (#448). The floating switcher: the variant with ← and →, the
 * state, the theme, and "Heartbeat now". Drawn in plain black and white so
 * it is never mistaken for the design. ← and → are ignored while typing.
 */
import { useEffect, type JSX } from "react";
import {
  STATES,
  THEMES,
  VARIANTS,
  updatePrototype,
  usePrototype,
  type ScreenState,
  type Theme,
} from "./prototype-state";

const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.matches("input, textarea, select") || target.isContentEditable);

export function Switcher(): JSX.Element {
  const { variant, state, theme, heartbeats } = usePrototype();
  const index = VARIANTS.findIndex((each) => each.key === variant);
  const step = (by: number): void =>
    updatePrototype({ variant: VARIANTS[(index + by + VARIANTS.length) % VARIANTS.length]!.key });

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
      <button type="button" onClick={() => step(-1)} aria-label="Previous variant">
        ←
      </button>
      <span className="proto-variant">
        <b>{variant}</b> {VARIANTS[index]!.name}
      </span>
      <button type="button" onClick={() => step(1)} aria-label="Next variant">
        →
      </button>
      <span className="proto-sep" />
      <select
        aria-label="Ada's state"
        value={state}
        onChange={(event) => updatePrototype({ state: event.target.value as ScreenState })}
      >
        {STATES.map((each) => (
          <option key={each.key} value={each.key}>
            Ada: {each.name}
          </option>
        ))}
      </select>
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
      <button type="button" onClick={() => updatePrototype({ heartbeats: heartbeats + 1 })}>
        ♥ Heartbeat now
      </button>
    </div>
  );
}
