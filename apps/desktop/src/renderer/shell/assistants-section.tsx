/**
 * The sidebar's Assistants section, as the Bureau book's crew.js draws it:
 * each assistant's face in its pose, its name, and the pose's word at the
 * row's end.
 */
import { memo, type JSX } from "react";
import { Link } from "@tanstack/react-router";
import { describePose, type AssistantRow, type Pose } from "@hercule/client-core";
import { buildLook, Face } from "../faces";
import { SELECTED_LINK_PROPS } from "../screens/selected-link-props";

/**
 * Renders the Assistants section: a heading, then one row per entry of
 * `rows`, in their order. Every assistant is listed; the section has no "more"
 * row, and is not virtualized, because an owner has a handful of assistants,
 * not hundreds. Renders nothing when `rows` is empty.
 *
 * The sidebar pins the section between the thread list and the foot, so it
 * stays in one place however many threads there are. Past 40% of the
 * sidebar's height, the rows scroll under the heading (sidebar.css).
 */
export function AssistantsSection({
  rows,
}: {
  readonly rows: readonly Pick<AssistantRow, "id" | "name" | "pose">[];
}): JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <nav className="side-sec--who" aria-label="Assistants">
      <h3 className="side-h">
        <span>Assistants</span>
      </h3>
      <div className="side-who-rows">
        {rows.map((row) => (
          <AssistantLink key={row.id} assistantId={row.id} name={row.name} pose={row.pose} />
        ))}
      </div>
    </nav>
  );
}

/**
 * Renders one assistant's row: a link to its Conversation, named
 * "<name>, <pose words>", such as "Ada, waiting on you". The router marks it
 * as the current page while the assistant's screen is open.
 *
 * The face is still in every pose, also while the assistant works: the
 * sidebar shows only still poses, so it costs nothing while the app is idle
 * (spec 17 §Performance, rule 2). The pose's word is drawn in the attention hue while the assistant
 * waits on the user. It is memoized, so a live push redraws only the rows
 * whose assistant changed.
 */
const AssistantLink = memo(function AssistantLink({
  assistantId,
  name,
  pose,
}: {
  readonly assistantId: string;
  readonly name: string;
  readonly pose: Pose;
}): JSX.Element {
  const word = describePose(pose);
  return (
    <Link
      to="/assistants/$assistantId"
      params={{ assistantId }}
      activeProps={SELECTED_LINK_PROPS}
      className="side-row side-row--who"
      aria-label={`${name}, ${word}`}
    >
      <Face look={buildLook(assistantId)} pose={pose} size={22} />
      <span className="side-name">{name}</span>
      <span
        className={pose === "waiting" ? "side-end side-presence you-ink" : "side-end side-presence"}
      >
        {word}
      </span>
    </Link>
  );
});
