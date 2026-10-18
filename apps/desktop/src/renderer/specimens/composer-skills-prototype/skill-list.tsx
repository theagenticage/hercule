/**
 * PROTOTYPE (#766). The `$` list of skills and the `/` list of commands,
 * docked to the top edge of the composer card. Stubs: the drawing replaces
 * them. Both are drawn from the query and the active row alone, and sit
 * where the caller puts them (see `SkillField`).
 */
import type { JSX } from "react";
import { buildSkillToken, ILLUSTRATIVE_COMMANDS, rankSkills, SKILLS, type Skill } from "./fixture";
import "./skill-list.css";

/**
 * Renders the skills `rankSkills` returns for `query`, one row each, with
 * row `activeRow` highlighted, or the empty state when none matches.
 */
export function SkillList({
  query,
  activeRow,
}: {
  readonly query: string;
  readonly activeRow: number | null;
}): JSX.Element {
  const rows = rankSkills(SKILLS, query);
  return (
    <div className="skill-list" role="listbox">
      {rows.length === 0 ? <div className="skill-list-empty">No skill matches</div> : null}
      {rows.map((skill, index) => (
        <div key={buildSkillToken(skill)} role="option" aria-selected={index === activeRow}>
          {`${index === activeRow ? ">" : " "} ${buildSkillToken(skill)} - ${skill.description} [${skill.source}]`}
        </div>
      ))}
    </div>
  );
}

/**
 * Renders the commands that match `query`, one row each, with row
 * `activeRow` highlighted. Skills show as `/skill:<name>`. With
 * `withOtherKinds`, the illustrative Hercule and harness commands are
 * listed beside them.
 */
export function CommandList({
  query,
  activeRow,
  withOtherKinds,
}: {
  readonly query: string;
  readonly activeRow: number | null;
  readonly withOtherKinds: boolean;
}): JSX.Element {
  const skills: Skill[] = rankSkills(SKILLS, query);
  const others = withOtherKinds
    ? ILLUSTRATIVE_COMMANDS.filter((each) => each.name.includes(query.toLowerCase()))
    : [];
  const rows = [
    ...others.map((each) => `/${each.name} - ${each.description} [${each.kind}]`),
    ...skills.map(
      (skill) =>
        `/skill:${buildSkillToken(skill).slice(1)} - ${skill.description} [${skill.source}]`,
    ),
  ];
  return (
    <div className="skill-list command-list" role="listbox">
      {rows.length === 0 ? <div className="skill-list-empty">No command matches</div> : null}
      {rows.map((row, index) => (
        <div key={row} role="option" aria-selected={index === activeRow}>
          {`${index === activeRow ? ">" : " "} ${row}`}
        </div>
      ))}
    </div>
  );
}
