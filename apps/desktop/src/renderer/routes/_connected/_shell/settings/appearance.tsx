import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { decideThemeInUse } from "../../../../../ipc/appearance";
import {
  DARK_APPEARANCE_QUERY,
  REDUCED_TRANSPARENCY_QUERY,
  useAppearance,
  useMediaQueryMatch,
} from "../../../../app/appearance";
import { rememberSettingsSection } from "../../../../app/last-settings-section";
import { FollowSystemRow } from "../../../../screens/settings/appearance/follow-system-row";
import { GlassSection } from "../../../../screens/settings/appearance/glass-section";
import { ThemeSection } from "../../../../screens/settings/appearance/theme-section";
import { SettingsHeaderActions } from "../../../../screens/settings/settings-frame";

/**
 * Settings > Appearance: how the app looks on this Mac (spec 17 §Settings,
 * Appearance). This part draws the theme cards, Follow the system with its
 * day and night themes, the Glass level and Reduce transparency.
 *
 * Every change shows in the window at once and is saved on this Mac, in
 * main's settings file, with one exception: while the Glass slider is
 * dragged, each step shows and only the level it ends on is saved.
 *
 * The page reads nothing from the controller, so it has no loader.
 */
export const Route = createFileRoute("/_connected/_shell/settings/appearance")({
  staticData: { title: "Appearance" },
  onEnter: () => {
    rememberSettingsSection("/settings/appearance");
  },
  component: Appearance,
});

function Appearance(): JSX.Element {
  const store = Route.useRouteContext().appearance;
  const appearance = useAppearance(store);
  const darkAppearance = useMediaQueryMatch(DARK_APPEARANCE_QUERY);
  const systemReducesTransparency = useMediaQueryMatch(REDUCED_TRANSPARENCY_QUERY);
  const themeInUse = decideThemeInUse(appearance, darkAppearance);
  return (
    <>
      <SettingsHeaderActions>
        <span className="time">Saved on this Mac</span>
      </SettingsHeaderActions>
      <ThemeSection
        themeInUse={themeInUse}
        onPick={(theme) => {
          store.save({ followSystem: false, theme });
        }}
      />
      <section className="set-sec">
        <FollowSystemRow
          followSystem={appearance.followSystem}
          dayTheme={appearance.dayTheme}
          nightTheme={appearance.nightTheme}
          onToggle={() => {
            // Turning Follow the system off keeps the theme the window shows
            // now, rather than one picked long ago.
            store.save(
              appearance.followSystem
                ? { followSystem: false, theme: themeInUse }
                : { followSystem: true },
            );
          }}
          onDayThemeChange={(dayTheme) => {
            store.save({ dayTheme });
          }}
          onNightThemeChange={(nightTheme) => {
            store.save({ nightTheme });
          }}
        />
      </section>
      <GlassSection
        glassPercent={appearance.glassPercent}
        reduceTransparency={appearance.reduceTransparency}
        systemReducesTransparency={systemReducesTransparency}
        onGlassInput={(glassPercent) => {
          store.show({ glassPercent });
        }}
        onGlassCommit={(glassPercent) => {
          store.save({ glassPercent });
        }}
        onReduceTransparencyToggle={() => {
          store.save({ reduceTransparency: !appearance.reduceTransparency });
        }}
      />
    </>
  );
}
