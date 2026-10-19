import { Fragment, useMemo, type JSX } from "react";
import { containsSkillReference, splitSkillReferences } from "@hercule/client-core";
import { HoverableSkillChip } from "../session/skill-chip";
import { useSessionSkills } from "../session/use-session-skills";

/**
 * Renders a queued input's text on one line, with a chip for each Skill
 * Reference (`$review`) that names a skill the session has now. The input has
 * not run yet, so the runner has translated nothing: the session's current
 * skills decide which `$name` is a chip. A typo, or a skill the session does
 * not have, stays text.
 *
 * Only a text that holds a reference reads the skills, in a component of its
 * own, because a hook cannot be called on a condition. While the read is
 * under way, or if it fails, the text is drawn as written.
 */
export function QueuedText({
  sessionId,
  text,
}: {
  readonly sessionId: string;
  readonly text: string;
}): JSX.Element {
  return (
    <span className="queued-text" title={text}>
      {containsSkillReference(text) ? (
        <QueuedTextWithSkills sessionId={sessionId} text={text} />
      ) : (
        text
      )}
    </span>
  );
}

/** Draws `text` as `QueuedText` describes, for a text that holds a Skill Reference. */
function QueuedTextWithSkills({
  sessionId,
  text,
}: {
  readonly sessionId: string;
  readonly text: string;
}): JSX.Element {
  const skillsByName = useSessionSkills(sessionId);
  const skillNames = useMemo(() => new Set(skillsByName.keys()), [skillsByName]);
  return (
    <>
      {splitSkillReferences(text, skillNames).map((part, index) =>
        part.type === "text" ? (
          <Fragment key={index}>{part.text}</Fragment>
        ) : (
          <HoverableSkillChip key={index} name={part.name} skill={skillsByName.get(part.name)} />
        ),
      )}
    </>
  );
}
