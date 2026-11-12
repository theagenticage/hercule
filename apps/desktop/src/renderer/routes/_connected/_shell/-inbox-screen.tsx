import { useState, type JSX } from "react";
import { useNavigate } from "@tanstack/react-router";
import { INBOX_PANE_DEFAULT_WIDTH, InboxFrame } from "../../../screens/inbox/inbox-frame";

/** Renders the Inbox screen: the page frame, with its slots not yet filled. */
export function InboxScreen(): JSX.Element {
  const navigate = useNavigate();
  const [paneWidth, setPaneWidth] = useState(INBOX_PANE_DEFAULT_WIDTH);
  return (
    <InboxFrame
      rail={null}
      scopeName="Someone waits on me"
      search={null}
      listHead={null}
      list={null}
      paneHead={null}
      pane={null}
      offlinePill={null}
      isPaneShown={false}
      isPaneOpen={false}
      paneWidth={paneWidth}
      onPaneWidthChange={setPaneWidth}
      onClosePane={() => undefined}
      onOpenIntake={() => {
        void navigate({ to: "/intake" });
      }}
      onOpenKeys={() => undefined}
      isKeysOpen={false}
    />
  );
}
