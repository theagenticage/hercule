import type { JSX } from "react";
import { DAY_THEMES, THEMES, type Theme } from "../../../../ipc/appearance";
import { Face, type Look } from "../../../faces";
import "./appearance.css";
import { THEME_NAMES } from "./theme-names";

// The two colleagues every preview draws. They are the colleagues the book
// casts by hand for this page: a session waiting on you and Ada, an
// assistant, at work in her cloche.
const WAITING_LOOK: Look = { hue: "peach", shape: "egg", accessories: ["tache"], headwear: null };
const WORKING_LOOK: Look = { hue: "iris", shape: "egg", accessories: [], headwear: "cloche" };

/**
 * Renders the Theme section of Settings > Appearance: a card for each of
 * Bureau's five themes, each with a preview drawn in its theme. The card of
 * `themeInUse` is pressed. Pressing a card calls `onPick` with its theme.
 * `error` is why the last pick failed to save, shown under the cards as a
 * row shows its own, or `null`.
 *
 * A card's accessible name is the theme's name and whether it is light or
 * dark, such as "Whitehaven light".
 */
export function ThemeSection({
  themeInUse,
  onPick,
  error,
}: {
  readonly themeInUse: Theme;
  readonly onPick: (theme: Theme) => void;
  readonly error: string | null;
}): JSX.Element {
  return (
    <section className="set-sec">
      <h2>Theme</h2>
      <p>
        Five rooms from the casebook, one crew. Every colleague keeps its colors in every theme.
      </p>
      <div className="themes">
        {THEMES.map((theme) => (
          <button
            key={theme}
            type="button"
            className="tp"
            aria-pressed={theme === themeInUse}
            onClick={() => {
              onPick(theme);
            }}
          >
            <ThemePreview theme={theme} />
            <span className="tp-name">
              {/* The space keeps the two words apart in the card's accessible
                  name. The flex row draws no whitespace between its items. */}
              <b>{THEME_NAMES[theme]}</b> <span>{isDayTheme(theme) ? "light" : "dark"}</span>
            </span>
          </button>
        ))}
      </div>
      {error !== null && (
        <p className="set-err" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** Checks whether `theme` is one of the light themes. */
const isDayTheme = (theme: Theme): boolean => (DAY_THEMES as readonly Theme[]).includes(theme);

/**
 * Renders a tiny app in `theme`: a sidebar, two rows of a thread with their
 * colleagues, and a composer. The theme's `data-theme` on the preview sets
 * that theme's tokens inside it, whatever theme the page is in.
 */
function ThemePreview({ theme }: { readonly theme: Theme }): JSX.Element {
  return (
    <span className="tp-art" data-theme={theme}>
      <span className="tp-side">
        <i />
        <i />
        <i />
        <i />
      </span>
      <span className="tp-main">
        <span className="tp-row">
          <Face look={WAITING_LOOK} pose="waiting" size={20} />
          <span className="tp-line" />
          <span className="tp-line tp-line--you" />
        </span>
        <span className="tp-row">
          <Face look={WORKING_LOOK} pose="working" size={20} />
          <span className="tp-line" />
        </span>
        <span className="tp-comp" />
      </span>
    </span>
  );
}
