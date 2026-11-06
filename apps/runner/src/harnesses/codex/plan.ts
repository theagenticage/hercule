import type { PlanType } from "./generated";

/**
 * Plan ids that Codex 0.167 can send but the generated `PlanType` (generated
 * from Codex 0.154) does not list yet. Delete an id here once regenerating
 * the bindings adds it to `PlanType`.
 */
type NewerPlanType = "promax" | "sci" | "sci_plus";

/**
 * The display name of each plan the account can have, as Codex's own `/status`
 * shows it. The app-server only sends the plan id, so the names come from the
 * table in Codex's terminal UI, kept in step with the latest Codex release:
 * https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/tui/src/subscription.rs#L12-L39
 *
 * Some names look odd (`business` is "Enterprise", `team` is "Business") but
 * they are what Codex shows, so they are copied as they are. `unknown` has no
 * name. The keys are typed so that regenerating the bindings with a new plan
 * id fails typecheck until the id gets a name here.
 */
const PLAN_LABELS: Readonly<Record<Exclude<PlanType, "unknown"> | NewerPlanType, string>> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro 200",
  prolite: "Pro 100",
  promax: "Pro 500",
  team: "Business",
  self_serve_business_prolite: "Business Premium",
  self_serve_business_usage_based: "Business",
  business: "Enterprise",
  ent26: "Enterprise",
  enterprise_cbp_automation: "Enterprise (Automation)",
  enterprise_cbp_usage_based: "Enterprise",
  enterprise: "Enterprise",
  edu: "Edu",
  edu_plus: "Edu Plus",
  edu_pro: "Edu Pro",
  sci: "Academic Researchers",
  sci_plus: "Academic Researchers Plus",
};

/**
 * Returns the display name of a plan id, or `undefined` for `unknown` and for
 * any id not in the table. Takes a plain string because the app-server's
 * answer is cast to `PlanType` and never checked, so a newer Codex can send
 * an id this build has never seen.
 */
export const describePlanType = (planType: string): string | undefined =>
  // An own-property check, so ids such as `toString` or `__proto__` find nothing.
  Object.hasOwn(PLAN_LABELS, planType)
    ? PLAN_LABELS[planType as keyof typeof PLAN_LABELS]
    : undefined;

/**
 * Checks whether a plan id is missing from the table while Codex claims to
 * know the plan. `unknown` is Codex saying it does not know, so it is not
 * missing. The probe logs a warning for such an id so a name can be added.
 */
export const isUnnamedPlanType = (planType: string): boolean =>
  planType !== "unknown" && describePlanType(planType) === undefined;
