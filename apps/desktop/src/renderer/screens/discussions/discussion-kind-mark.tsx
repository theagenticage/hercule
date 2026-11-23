import type { JSX } from "react";
import type { DiscussionKind } from "@hercule/contract";
import { ChatIcon } from "../../icons/chat";
import { OverlapIcon } from "../../icons/overlap";
import "./discussions.css";

/**
 * Renders the mark of a Discussion's kind, `size` CSS pixels square: two
 * rings for a Discussion that an edit overlap opened, and a speech bubble for
 * a general one, which an agent or the user opened. Hovering it shows why the
 * Discussion exists.
 */
export function DiscussionKindMark({
  kind,
  size,
}: {
  readonly kind: DiscussionKind;
  readonly size: number;
}): JSX.Element {
  return kind === "overlap" ? (
    <span className="kind-mark kind-mark--overlap" title="Opened by an edit overlap">
      <OverlapIcon size={size} />
    </span>
  ) : (
    <span className="kind-mark kind-mark--general" title="Opened by an agent or the user">
      <ChatIcon size={size} />
    </span>
  );
}
