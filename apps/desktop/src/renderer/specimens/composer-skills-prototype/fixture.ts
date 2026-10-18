/**
 * PROTOTYPE (#766). The skills the Fix thread offers in its composer: the
 * Skill Library part the session was started with, and the skills the
 * `webshop` checkout holds in its own `.claude/skills`.
 *
 * The shapes are the prototype's own, close to what #768's session skill
 * list will return, so the screens can be read against the model. Nothing
 * here is the contract.
 */

/** Names one skill: a Skill Library skill by its name, a repository skill by its checkout folder and name. */
export type SkillRef =
  | { readonly source: "library"; readonly name: string }
  | { readonly source: "repository"; readonly checkout: string; readonly name: string };

/** One skill of the thread, as the lists and the hover card show it. */
export type Skill = SkillRef & { readonly description: string };

const library = (name: string, description: string): Skill => ({
  source: "library",
  name,
  description,
});

const webshop = (name: string, description: string): Skill => ({
  source: "repository",
  checkout: "webshop",
  name,
  description,
});

/** Compares two skills by name, and by source when two skills share a name (`review` of the library, then `review` of the checkout). */
const compareSkillsByName = (a: Skill, b: Skill): number =>
  a.name.localeCompare(b.name) || a.source.localeCompare(b.source);

/**
 * The skills of the thread, sorted by name once, when the module loads, so
 * that `rankSkills` can keep this order instead of sorting on every
 * keystroke. Two descriptions hold "imp" without any name doing so
 * (`handoff` and `codebase-design`), for the `$imp` scenes. `code-review`'s
 * description is too long for one line.
 */
export const SKILLS: ReadonlyArray<Skill> = [
  library(
    "code-review",
    "Review the changes since a fixed point (commit, branch, tag, or merge-base) along two axes: Standards (does the code follow this repo's documented coding standards?) and Spec (does the code match what the originating issue asked for?), in parallel sub-agents",
  ),
  library(
    "codebase-design",
    "Shared vocabulary for deep modules: find deepening opportunities and decide where a seam goes, even when a module imports half the repo",
  ),
  library(
    "debug",
    "Find the evidenced root cause of a failure before changing a line, then fix it and keep the reproduction as a test",
  ),
  library(
    "domain-modeling",
    "Build and sharpen the project's domain model: CONTEXT.md terms and ADRs",
  ),
  library("grilling", "Grill the user about a plan, decision or idea until it holds up"),
  library(
    "handoff",
    "Compact the conversation into a handoff document, keeping what is important for the next agent",
  ),
  library(
    "implement",
    "Build a locked SPEC one slice at a time: tests from the spec first, then the code, then a review round",
  ),
  library(
    "improve-codebase-architecture",
    "Scan the codebase for deepening opportunities and grill through the one you pick",
  ),
  library("playwright-cli", "Automate browser interactions and test web pages"),
  library("prototype", "Build a throwaway prototype to answer a design question"),
  library("research", "Investigate a question against primary sources and write the findings down"),
  library("review", "Review a diff with independent sub-agent reviewers who try to break it"),
  library("ship", "Check the outgoing set, commit, push, and open cross-referenced pull requests"),
  library("spec", "Turn a feature idea into a locked SPEC through a question-and-answer interview"),
  library("teach", "Teach the user a new skill or concept within this workspace"),
  library("to-tickets", "Break a plan into tracer-bullet tickets with their blocking edges"),
  library(
    "triage",
    "Move issues and pull requests through the triage states and write agent briefs",
  ),
  library("wayfinder", "Plan work too big for one session as a map of decision tickets"),
  webshop(
    "release-checklist",
    "Walk the release checklist before a deploy: migrations, flags, Stripe webhooks, rollback",
  ),
  webshop(
    "review",
    "Review a checkout or storefront change against the shop's payment and accessibility rules",
  ),
  webshop(
    "stripe-fixtures",
    "Create and reset Stripe test customers, 3-D Secure cards and failed charges",
  ),
].sort(compareSkillsByName);

/** Returns the text a skill has in a message: `$name`, or `$checkout:name` for a repository skill. */
export const buildSkillToken = (skill: SkillRef): string =>
  skill.source === "library" ? `$${skill.name}` : `$${skill.checkout}:${skill.name}`;

/** Each skill of the thread by its message token, built once so a lookup does not rebuild every token. */
const SKILLS_BY_TOKEN: ReadonlyMap<string, Skill> = new Map(
  SKILLS.map((skill) => [buildSkillToken(skill), skill]),
);

/** Returns the skill that `token` (such as `$review`) names, or `undefined` when no skill of the thread has that token. */
export const findSkillByToken = (token: string): Skill | undefined => SKILLS_BY_TOKEN.get(token);

/** Returns the skill `ref` names. Fails when the thread has no such skill. */
export const findSkill = (ref: SkillRef): Skill => {
  const token = buildSkillToken(ref);
  const skill = findSkillByToken(token);
  if (skill === undefined) throw new Error(`The fixture has no skill ${token}.`);
  return skill;
};

/**
 * Returns the skills that match `query`, in the order the `$` and `/` lists
 * show them: first those whose name matches, then those whose description
 * matches and whose name does not, each group in the order of `skills`.
 * `skills` must be sorted by name, as `SKILLS` is. `query` is what the user
 * typed after the `$` or `/`, and an empty one matches every skill by name.
 * A match ignores case and looks for the query anywhere in the text. A
 * repository skill's name is `<checkout>:<name>`, so `web` finds the skills
 * of the `webshop` checkout.
 */
export const rankSkills = (skills: ReadonlyArray<Skill>, query: string): Skill[] => {
  const needle = query.trim().toLowerCase();
  const nameMatches: Skill[] = [];
  const descriptionMatches: Skill[] = [];
  for (const skill of skills) {
    if (buildSkillToken(skill).slice(1).toLowerCase().includes(needle)) {
      nameMatches.push(skill);
    } else if (skill.description.toLowerCase().includes(needle)) {
      descriptionMatches.push(skill);
    }
  }
  return [...nameMatches, ...descriptionMatches];
};

/**
 * A command that is not a skill. ILLUSTRATIVE: neither Hercule nor any
 * harness defines these rows yet. They exist so the `/` list can be drawn
 * with more than one kind of row.
 */
export interface IllustrativeCommand {
  /** `hercule` for a command of the app, `harness` for one of the thread's harness. */
  readonly kind: "hercule" | "harness";
  /** The command's name after the `/`. */
  readonly name: string;
  readonly description: string;
}

/** ILLUSTRATIVE commands for the `slash-kinds` scene, see `IllustrativeCommand`. */
export const ILLUSTRATIVE_COMMANDS: ReadonlyArray<IllustrativeCommand> = [
  { kind: "hercule", name: "fork", description: "Fork this thread into a new worktree" },
  {
    kind: "hercule",
    name: "status",
    description: "Show the model, effort and workspace of this thread",
  },
  { kind: "harness", name: "clear", description: "Start over with an empty context" },
  { kind: "harness", name: "compact", description: "Summarize the conversation to free context" },
];
