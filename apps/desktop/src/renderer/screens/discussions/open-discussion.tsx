/**
 * The open Discussion's lead: its subject as the page's heading, with the
 * overlap mark of a Discussion an edit overlap opened, then chips for its
 * repository and its size (spec 19 section 8.2).
 */
import type { JSX } from "react";
import { describeSessionsAndPosts, stripCodeMarks } from "@hercule/client-core/discussion-text";
import { formatRepositoryPath } from "@hercule/client-core";
import type { DiscussionSummary } from "@hercule/contract";
import { BranchIcon } from "../../icons/branch";
import { InlineCode } from "./inline-code";
import { OverlapMark } from "./overlap-mark";
import "../workflows/workflow-detail.css";
import "./discussions.css";

/** The size of the overlap mark beside the subject, in CSS pixels. */
const MARK_SIZE = 16;

/** The size of the branch icon in the repository chip, in CSS pixels. */
const CHIP_ICON_SIZE = 12;

/**
 * Renders the lead of `discussion`. The subject is the heading, with the id
 * `headingId`, so the page can take its name from it.
 */
export function DiscussionLead({
  headingId,
  discussion,
}: {
  readonly headingId: string;
  readonly discussion: DiscussionSummary;
}): JSX.Element {
  const subject = stripCodeMarks(discussion.subject);
  return (
    <div className="open-lead">
      <div className="open-name">
        {discussion.kind === "overlap" ? <OverlapMark size={MARK_SIZE} /> : null}
        <h1 id={headingId} title={subject}>
          <InlineCode text={discussion.subject} />
        </h1>
      </div>
      <ul className="chip-row" aria-label="About this discussion">
        <li className="chip">
          <BranchIcon size={CHIP_ICON_SIZE} />
          {formatRepositoryPath(discussion.repository)}
        </li>
        <li className="chip">{describeSessionsAndPosts(discussion)}</li>
      </ul>
    </div>
  );
}
