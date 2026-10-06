/**
 * The header of a subagent's page. Only the subagent's page imports this
 * module, so the header loads the first time a subagent's page opens, not
 * with the thread's page (spec 17 §What subagents cost).
 */
import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import {
  decideSubagentMark,
  isSubagentWaiting,
  listSubagentAncestors,
  nameSubagent,
} from "@hercule/client-core";
import type { Session, Subagent } from "@hercule/contract";
import { buildHueStyle } from "../../faces";
import { Mark } from "../../marks";
import { SidePaneToggle } from "../thread/thread-header";
import { buildSubagentLook } from "./subagent-face";
import "./subagent-header.css";

/** Marks a link as the current page only on its own path, not on a path below it. */
const EXACT_PATH = { exact: true } as const;

/**
 * Renders the header of `subagent`'s page: a crumb from the thread down
 * through the subagent's ancestors to the subagent, then the side pane's
 * toggle.
 *
 * - `session` is the thread's session, and `subagents` are its subagents,
 *   which hold the ancestors.
 * - The thread and each ancestor are links to their pages.
 * - The subagent comes last, with its mark, its name and a "subagent" tag,
 *   tinted in its hue so the page cannot pass for a thread.
 *
 * When the header runs out of room, the thread and the ancestors shrink
 * first, down to about four letters each, then the subagent's name. The
 * thread's crumb is never wider than 260px and the subagent's than 340px.
 */
export function SubagentHeader({
  session,
  subagent,
  subagents,
}: {
  readonly session: Session;
  readonly subagent: Subagent;
  readonly subagents: readonly Subagent[];
}): JSX.Element {
  const mark = decideSubagentMark(
    subagent.status,
    isSubagentWaiting(subagent, session.openRequests),
  );
  const name = nameSubagent(subagent);

  return (
    <header className="top">
      <nav className="pill subagent-crumbs" aria-label="Subagent's place in the thread">
        {/* Exact, so the router does not mark the thread's page as the
            current one: the subagent's page sits under its path. */}
        <Link
          to="/threads/$sessionId"
          params={{ sessionId: session.id }}
          activeOptions={EXACT_PATH}
          className="ptab"
        >
          <span className="ptab-title" title={session.title}>
            {session.title}
          </span>
        </Link>
        {listSubagentAncestors(subagent, subagents).map((ancestor) => (
          <span key={ancestor.id} className="subagent-crumb">
            <span className="subagent-crumb-sep" aria-hidden="true">
              ›
            </span>
            <Link
              to="/threads/$sessionId/subagents/$subagentId"
              params={{ sessionId: session.id, subagentId: ancestor.id }}
              className="ptab"
            >
              <span className="ptab-title" title={nameSubagent(ancestor)}>
                {nameSubagent(ancestor)}
              </span>
            </Link>
          </span>
        ))}
        <span className="subagent-crumb">
          <span className="subagent-crumb-sep" aria-hidden="true">
            ›
          </span>
          <span
            className="ptab is-on subagent-crumb-here"
            aria-current="page"
            style={buildHueStyle(buildSubagentLook(subagent).hue)}
          >
            {/* The marks have no glyph for stopped. A stopped subagent does
                nothing, so it takes the idle mark, as its face takes the
                idle pose. */}
            <Mark state={mark === "stopped" ? "idle" : mark} />
            <span className="ptab-title" title={name}>
              {name}
            </span>
            <small className="subagent-tag">subagent</small>
          </span>
        </span>
      </nav>
      <span className="spacer" />
      <SidePaneToggle sessionId={session.id} />
    </header>
  );
}
