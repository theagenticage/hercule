import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { threadRowsMode } from "@hydra/client-core";
import type { ThreadRows } from "@hydra/contract";
import { FormCard, Row, SegmentedControl, SegmentedControlItem } from "@hydra/ui";
import { settingsQuery } from "../../../app/queries";
import { SaveStatus } from "../../../screens/save-status";
import { useSaveSettings } from "./-form";

export const Route = createFileRoute("/_shell/settings/threads")({
  staticData: { title: "Threads" },
  component: Threads,
});

/**
 * The shell's one display preference. It is a preference rather than a form, so
 * a choice is written the moment it is made and the sidebar follows.
 */
function Threads(): JSX.Element {
  const { client } = Route.useRouteContext();
  const settings = useSuspenseQuery(settingsQuery(client)).data;
  const { save, saved, failure } = useSaveSettings(client);

  const rows = threadRowsMode(settings.user["ui.threadRows"]);

  return (
    <FormCard
      label="Threads · display"
      fine={
        rows === "plain"
          ? "Plain rows show a thread's title and its age."
          : "Meta rows add a second line with the checkout or branch, the pull request and the model."
      }
    >
      <Row label="Sidebar rows">
        <SegmentedControl
          aria-label="Sidebar rows"
          className="w-[220px]"
          value={rows}
          onValueChange={(next) => {
            save({ user: { "ui.threadRows": next as ThreadRows } });
          }}
        >
          <SegmentedControlItem value="meta">meta</SegmentedControlItem>
          <SegmentedControlItem value="plain">plain</SegmentedControlItem>
        </SegmentedControl>
      </Row>
      <SaveStatus saved={saved} failure={failure} />
    </FormCard>
  );
}
