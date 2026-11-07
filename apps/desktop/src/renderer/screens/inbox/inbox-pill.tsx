import type { JSX } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ViewPill } from "../desk";
import type { ViewChoice } from "../view-switch";

/** The views of the Inbox's pill. Cards is this page. Intake is another page, reached from here until it has no row of its own. */
type InboxPillView = "cards" | "intake";

const CHOICES: ReadonlyArray<ViewChoice<InboxPillView>> = [
  { view: "cards", label: "Cards" },
  { view: "intake", label: "Intake" },
];

/**
 * Renders the Inbox's view pill: "Inbox", then a tab for Cards (this page,
 * selected) and one for Intake, so it reads `Inbox | Cards | Intake`. There
 * are no icons and no count on Intake. Pressing Intake opens `/intake`.
 */
export function InboxPill(): JSX.Element {
  const navigate = useNavigate();
  return (
    <ViewPill
      title="Inbox"
      label="Inbox views"
      choices={CHOICES}
      view="cards"
      onPick={(view) => {
        if (view === "intake") void navigate({ to: "/intake" });
      }}
    />
  );
}
