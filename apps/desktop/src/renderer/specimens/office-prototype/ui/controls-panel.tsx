/**
 * PROTOTYPE - the controls panel: one control for every setting of the
 * office, on a glass panel at the top right. The top bar's sliders button and
 * the full stop key show and hide it.
 *
 * The store also has a field that hides the sidebar, but the app's shell has
 * no way to hide its sidebar yet, so the panel offers no control for it and
 * says so at its foot.
 */
import { useSyncExternalStore, type JSX, type ReactNode } from "react";
import { SlidersIcon } from "../../../icons";
import type { CharacterStyle } from "../engine/contracts";
import type { Quality, TimeOfDay } from "../engine/stage";
import {
  readOffice,
  setOffice,
  subscribeOffice,
  THEMES,
  VARIANTS,
  type OfficeState,
  type TagMode,
  type ThemeName,
} from "../office-store";
import type { FleetSize } from "../world/types";
import { CloseIcon } from "./office-icons";

/** One choice of a segmented control: the value it picks and its label. */
interface Choice<T> {
  readonly value: T;
  readonly label: string;
}

const THEME_NAMES: Readonly<Record<ThemeName, string>> = {
  whitehaven: "Whitehaven",
  styles: "Styles",
  "orient-express": "Orient Express",
  nile: "Nile",
  "end-house": "End House",
};

const TIMES: ReadonlyArray<Choice<TimeOfDay>> = [
  { value: "auto", label: "Theme" },
  { value: "morning", label: "Morning" },
  { value: "noon", label: "Noon" },
  { value: "evening", label: "Evening" },
  { value: "night", label: "Night" },
];

const FLEETS: ReadonlyArray<Choice<FleetSize>> = [
  { value: "today", label: "Today" },
  { value: "growing", label: "Growing" },
  { value: "ten-x", label: "Ten times" },
];

const STYLES: ReadonlyArray<Choice<CharacterStyle>> = [
  { value: "bean", label: "Bean" },
  { value: "suited", label: "Suited" },
];

const TAGS: ReadonlyArray<Choice<TagMode>> = [
  { value: "all", label: "All" },
  { value: "smart", label: "Smart" },
  { value: "none", label: "None" },
];

const QUALITIES: ReadonlyArray<Choice<Quality>> = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const LIVELINESS: ReadonlyArray<Choice<OfficeState["liveliness"]>> = [
  { value: 0, label: "Still" },
  { value: 1, label: "Calm" },
  { value: 2, label: "Bustling" },
];

/** Renders one setting: its name, an optional note after it, and its control below. */
function Setting({
  name,
  note,
  children,
}: {
  readonly name: string;
  readonly note?: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="office-setting">
      <div className="q-h">
        {name}
        {note === undefined ? null : <span className="office-setting-note">{note}</span>}
      </div>
      {children}
    </div>
  );
}

/** Renders a segmented control that picks one of `choices`, with `value` pressed. */
function Segments<T extends string | number>({
  name,
  choices,
  value,
  onPick,
}: {
  readonly name: string;
  readonly choices: ReadonlyArray<Choice<T>>;
  readonly value: T;
  readonly onPick: (value: T) => void;
}): JSX.Element {
  return (
    <div className="seg" role="group" aria-label={name}>
      {choices.map((choice) => (
        <button
          key={choice.value}
          type="button"
          aria-pressed={choice.value === value}
          onClick={() => onPick(choice.value)}
        >
          {choice.label}
        </button>
      ))}
    </div>
  );
}

/** Renders a row that switches a setting on and off. */
function Switch({
  name,
  on,
  onFlip,
}: {
  readonly name: string;
  readonly on: boolean;
  readonly onFlip: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="line office-switch"
      role="switch"
      aria-checked={on}
      onClick={onFlip}
    >
      <span className="grow">
        <b>{name}</b>
      </span>
      <span className="toggle" aria-hidden="true" />
    </button>
  );
}

/** Renders the controls panel. It stays mounted and fades in and out with the store's `controls` field. */
export function ControlsPanel(): JSX.Element {
  const state = useSyncExternalStore(subscribeOffice, readOffice);
  return (
    <section
      className="pop office-controls"
      data-open={state.controls}
      inert={!state.controls}
      aria-label="Controls"
    >
      <header className="pop-h">
        <SlidersIcon size={16} />
        <b>Controls</b>
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-label="Close"
          onClick={() => setOffice({ controls: false })}
        >
          <CloseIcon size={14} />
        </button>
      </header>
      <div className="pop-sec">
        <Setting name="Layout">
          <Segments
            name="Layout"
            choices={VARIANTS.map((variant) => ({ value: variant.key, label: variant.name }))}
            value={state.variant}
            onPick={(variant) => setOffice({ variant, roomId: null })}
          />
        </Setting>
        <Setting name="Theme" note={THEME_NAMES[state.theme]}>
          <div className="office-swatches" role="group" aria-label="Theme">
            {THEMES.map((theme) => (
              <button
                key={theme}
                type="button"
                className="office-swatch"
                aria-label={THEME_NAMES[theme]}
                aria-pressed={theme === state.theme}
                title={THEME_NAMES[theme]}
                onClick={() => setOffice({ theme })}
              >
                <span data-theme={theme} />
              </button>
            ))}
          </div>
        </Setting>
        <Setting name="Time of day">
          <Segments
            name="Time of day"
            choices={TIMES}
            value={state.timeOfDay}
            onPick={(timeOfDay) => setOffice({ timeOfDay })}
          />
        </Setting>
      </div>
      <div className="pop-sec">
        <Setting name="Fleet" note="Reloads the page">
          <Segments
            name="Fleet"
            choices={FLEETS}
            value={state.fleet}
            onPick={(fleet) => setOffice({ fleet })}
          />
        </Setting>
        <Setting name="Characters">
          <Segments
            name="Characters"
            choices={STYLES}
            value={state.style}
            onPick={(style) => setOffice({ style })}
          />
        </Setting>
        <Setting name="Name tags">
          <Segments
            name="Name tags"
            choices={TAGS}
            value={state.tags}
            onPick={(tags) => setOffice({ tags })}
          />
        </Setting>
        <Setting name="Liveliness">
          <Segments
            name="Liveliness"
            choices={LIVELINESS}
            value={state.liveliness}
            onPick={(liveliness) => setOffice({ liveliness })}
          />
        </Setting>
      </div>
      <div className="pop-sec">
        <Setting name="Quality">
          <Segments
            name="Quality"
            choices={QUALITIES}
            value={state.quality}
            onPick={(quality) => setOffice({ quality })}
          />
        </Setting>
        <Switch name="Event flow" on={state.flow} onFlip={() => setOffice({ flow: !state.flow })} />
        <Switch
          name="Performance readout"
          on={state.perf}
          onFlip={() => setOffice({ perf: !state.perf })}
        />
      </div>
      <p className="pop-foot">The sidebar always shows: the app's shell cannot hide it yet.</p>
    </section>
  );
}
