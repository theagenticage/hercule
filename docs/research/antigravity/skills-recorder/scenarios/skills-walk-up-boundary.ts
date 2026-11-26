import { runWalkUp } from "./_walk-up.ts";

await runWalkUp("skills-walk-up-boundary", true, "the same layout as skills-walk-up with an empty .git file in S: the walk stops at S, so P's skill, AGENTS.md and hook do not reach the session, and S's own skill, AGENTS.md and hook still do");
