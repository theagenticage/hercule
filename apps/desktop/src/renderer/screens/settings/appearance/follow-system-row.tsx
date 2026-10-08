import type { JSX } from "react";
import {
  DAY_THEMES,
  NIGHT_THEMES,
  type DayTheme,
  type NightTheme,
} from "../../../../ipc/appearance";
import { MoonIcon } from "../../../icons/moon";
import { SunIcon } from "../../../icons/sun";
import { SettingRow } from "../setting-row";
import { THEME_NAMES } from "./theme-names";
import "./appearance.css";

/**
 * Renders the Follow the system row of Settings > Appearance: its switch,
 * and the selects of the day theme, a light one, and the night theme, a
 * dark one.
 *
 * - The switch is named "Follow the system"; pressing it calls `onToggle`.
 * - The selects are named "Day theme" and "Night theme", and call
 *   `onDayThemeChange` and `onNightThemeChange`. They stay enabled while the
 *   switch is off, so the user can set up the pair before turning it on.
 *
 * The hint names the two themes the row switches between.
 */
export function FollowSystemRow({
  followSystem,
  dayTheme,
  nightTheme,
  onToggle,
  onDayThemeChange,
  onNightThemeChange,
}: {
  readonly followSystem: boolean;
  readonly dayTheme: DayTheme;
  readonly nightTheme: NightTheme;
  readonly onToggle: () => void;
  readonly onDayThemeChange: (theme: DayTheme) => void;
  readonly onNightThemeChange: (theme: NightTheme) => void;
}): JSX.Element {
  return (
    <SettingRow
      label="Follow the system"
      hint={`Switches with macOS: ${THEME_NAMES[dayTheme]} by day, ${THEME_NAMES[nightTheme]} by night.`}
      control={(labels) => (
        <>
          <div className="pair">
            <span className="field field--select">
              <SunIcon size={14} />
              <select
                aria-label="Day theme"
                value={dayTheme}
                onChange={(event) => {
                  onDayThemeChange(event.target.value as DayTheme);
                }}
              >
                {DAY_THEMES.map((theme) => (
                  <option key={theme} value={theme}>
                    {THEME_NAMES[theme]}
                  </option>
                ))}
              </select>
            </span>
            <span className="field field--select">
              <MoonIcon size={14} />
              <select
                aria-label="Night theme"
                value={nightTheme}
                onChange={(event) => {
                  onNightThemeChange(event.target.value as NightTheme);
                }}
              >
                {NIGHT_THEMES.map((theme) => (
                  <option key={theme} value={theme}>
                    {THEME_NAMES[theme]}
                  </option>
                ))}
              </select>
            </span>
          </div>
          <button
            type="button"
            className="toggle"
            role="switch"
            aria-checked={followSystem}
            {...labels}
            onClick={onToggle}
          />
        </>
      )}
    />
  );
}
