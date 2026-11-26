import { runWalkUp } from "./_walk-up.ts";

await runWalkUp("skills-walk-up", false, "an additional directory S inside a git repository P (no .git in S): agy walks up from S to P and loads P's skill and AGENTS.md, and P's hook runs on tool use, besides S's own skill, AGENTS.md and hook");
