import type { JSX } from "react";
import { Toolbar } from "../desk";
import "./inbox-frame.css";

/** Renders the Inbox's page frame: the desk with the toolbar row on top, naming the page "Inbox". */
export function InboxFrame(): JSX.Element {
  return (
    <div className="inbox-frame">
      <Toolbar
        start={
          <div className="pill">
            <h1 className="pill-title">Inbox</h1>
          </div>
        }
        isCrowded={false}
        end={null}
      >
        {null}
      </Toolbar>
    </div>
  );
}
