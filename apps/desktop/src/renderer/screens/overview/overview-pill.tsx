import { useCallback, useEffect, useState, type JSX } from "react";
import { useMatch, useNavigate, useRouteContext } from "@tanstack/react-router";
import { rememberOverviewView, type OverviewView } from "../../app/overview-view";
import { isOtherModifierHeld, isPrimaryModifierHeld } from "../../app/primary-modifier";
import { isTextField } from "../../app/text-field";
import { ViewPill } from "../desk";
import type { ViewChoice } from "../workflows/view-switch";

/** The Overview's views, left to right. */
const CHOICES: ReadonlyArray<ViewChoice<OverviewView>> = [
  { view: "office", label: "Office" },
  { view: "work", label: "Work" },
];

/** The view each number key picks, with ⌘ held: ⌘1 is the Office and ⌘2 is Work. */
const VIEW_OF_KEY: Readonly<Record<string, OverviewView>> = { "1": "office", "2": "work" };

/**
 * The view the user last switched away from with the pill or a shortcut, until
 * the pill of the view they switched to has drawn. Each view draws its own
 * pill, so the pill of the new view starts its puck here and slides it to its
 * own tab, which is how the puck is seen to slide from one view to the other.
 */
let switchedFrom: OverviewView | null = null;

/**
 * Renders the Overview's view pill: "Overview", then a tab for the Office and
 * one for Work, with the open view selected. Both the Office and Work draw it,
 * at the same place, so it reads as one pill that stays while the view changes.
 *
 * - Pressing a tab, or ⌘1 for the Office and ⌘2 for Work, opens that view.
 *   The shortcuts work on both views, except in a text field, which keeps its
 *   keys, and when something else already handled the key, such as the
 *   project picker. On both views the pill takes the two keys, so the Go
 *   menu's first two items do not open from them.
 * - The view open now is remembered, so the sidebar's Overview row opens it
 *   again.
 */
export function OverviewPill(): JSX.Element {
  const { controller, bridge } = useRouteContext({ from: "/_connected/_shell" });
  const navigate = useNavigate();
  const view: OverviewView =
    useMatch({ from: "/_connected/_shell/work", shouldThrow: false }) === undefined
      ? "office"
      : "work";
  // The puck is first put on the view that was left, and a frame later
  // moves to this one, so it slides.
  const [puckView, setPuckView] = useState<OverviewView>(() => switchedFrom ?? view);
  useEffect(() => {
    switchedFrom = null;
    if (puckView === view) return;
    const frame = requestAnimationFrame(() => setPuckView(view));
    return () => cancelAnimationFrame(frame);
  }, [puckView, view]);

  const controllerUrl = controller.url;
  useEffect(() => {
    rememberOverviewView(controllerUrl, view);
  }, [controllerUrl, view]);

  const open = useCallback(
    (next: OverviewView): void => {
      if (next === view) return;
      switchedFrom = view;
      void navigate({ to: next === "work" ? "/work" : "/office" });
    },
    [navigate, view],
  );
  const platform = bridge.platform;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const next = VIEW_OF_KEY[event.key];
      if (next === undefined || event.defaultPrevented || event.shiftKey || event.altKey) return;
      if (!isPrimaryModifierHeld(event, platform) || isOtherModifierHeld(event, platform)) return;
      if (isTextField(event.target)) return;
      // The page sees a shortcut before the menu does, and a handled one never
      // reaches it: without this, the Go menu would open its first two items.
      event.preventDefault();
      open(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, platform]);

  return (
    <ViewPill
      title="Overview"
      label="Overview views"
      choices={CHOICES}
      view={puckView}
      onPick={open}
    />
  );
}
