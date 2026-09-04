import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { EmptyState } from "@hydra/ui";
import { ConnectRows } from "../../screens/connect-rows";

export const Route = createFileRoute("/_shell/notifications")({
  staticData: { title: "Notifications" },
  component: Notifications,
});

function Notifications(): JSX.Element {
  return (
    <EmptyState
      headline="Decisions and outcomes will land here."
      lead="Everything Hydra asks you or reports shows on this screen. To hear it away from the browser, connect a chat channel; your assistant answers there too."
      fine="Channel setup ends with a pairing code you send the bot in a direct message. That code makes you its owner, the one whose answers it takes."
    >
      <ConnectRows
        reason="Connecting a channel is not built yet."
        offers={[
          {
            name: "Discord",
            gist: "a bot in your server · decisions as buttons, your assistant in any channel or DM",
          },
          {
            name: "Slack",
            gist: "a bot in your workspace · decisions as buttons, your assistant in threads and DMs",
          },
        ]}
      />
    </EmptyState>
  );
}
