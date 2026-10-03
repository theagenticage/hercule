/**
 * PROTOTYPE - the floating bar that switches between the office's variants:
 * the arrows, or ← and → on the keyboard. The release build never draws it.
 */
import { useEffect, useSyncExternalStore, type JSX } from "react";
import { readOffice, setOffice, subscribeOffice, VARIANTS } from "../office-store";

/** Returns the variant `step` places away from the current one, wrapping at both ends. */
function stepVariant(step: number): void {
  const index = VARIANTS.findIndex((variant) => variant.key === readOffice().variant);
  const next = VARIANTS[(index + step + VARIANTS.length) % VARIANTS.length]!;
  setOffice({ variant: next.key, roomId: null });
}

/** Returns true when `target`, the keyboard's focus, is a field, where the arrows move the caret. */
export const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/** Renders the bar at the bottom that steps between the office's layouts, with the arrow keys too. */
export function VariantBar(): JSX.Element | null {
  const state = useSyncExternalStore(subscribeOffice, readOffice);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "ArrowLeft") stepVariant(-1);
      else if (event.key === "ArrowRight") stepVariant(1);
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  if (import.meta.env.PROD) return null;
  const index = VARIANTS.findIndex((variant) => variant.key === state.variant);
  const variant = VARIANTS[index]!;
  return (
    <div className="variant-bar" role="toolbar" aria-label="Prototype variants">
      <button
        type="button"
        className="variant-bar-step"
        aria-label="Previous variant"
        onClick={() => stepVariant(-1)}
      >
        ←
      </button>
      <div className="variant-bar-name">
        <span className="variant-bar-key">{variant.key}</span>
        {variant.name}
        <span className="variant-bar-count">
          {index + 1} / {VARIANTS.length}
        </span>
      </div>
      <button
        type="button"
        className="variant-bar-step"
        aria-label="Next variant"
        onClick={() => stepVariant(1)}
      >
        →
      </button>
    </div>
  );
}
