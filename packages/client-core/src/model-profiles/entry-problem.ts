/**
 * Words for why a Model Profile entry cannot run, shortened to fit the right
 * side of a menu row or a select option. Both the composer's model menu and
 * Settings > System's text generation choices use them, so one reason never
 * reads two ways. The controller also sends a full sentence with each problem
 * (`EntryProblem.message`); the composer's "can't start" line uses that
 * sentence, and these words are for places that have room for a few.
 */
import type { EntryProblemReason } from "@hercule/contract";
import type { HarnessLoginMethod } from "../provider-accounts";

/** What the words depend on besides the reason. */
export interface EntryProblemSubject {
  /** The display name of the harness the entry runs in, such as `Claude Code`. */
  readonly harnessName: string;
  /** The machine the reason is about, or `null` when it is about no machine in particular. */
  readonly machineName: string | null;
  /** How the account's kind gets its credential, which decides whether a missing one is a key or a token. */
  readonly loginMethod: HarnessLoginMethod | null;
}

/** The reasons that depend on a machine: what is installed and signed in there, or whether one is connected. */
export type MachineProblemReason = Exclude<
  EntryProblemReason,
  "model-left-catalog" | "harness-lacks-model" | "harness-not-allowed"
>;

/**
 * Checks that the reason depends on a machine. The other reasons are about the
 * entry itself (its model, or the harness it names), so they hold on every
 * machine and no sign-in fixes them.
 */
export const isMachineProblemReason = (
  reason: EntryProblemReason,
): reason is MachineProblemReason =>
  reason !== "model-left-catalog" &&
  reason !== "harness-lacks-model" &&
  reason !== "harness-not-allowed";

/**
 * Returns a few words for `reason`, such as `not signed in on moss`,
 * `expired`, or `Claude Code is not on moss`. When `machineName` is `null` the
 * words speak of machines in general (`Claude Code is not on any machine`).
 */
export const describeEntryProblem = (
  reason: EntryProblemReason,
  { harnessName, machineName, loginMethod }: EntryProblemSubject,
): string => {
  switch (reason) {
    case "not-signed-in":
      return machineName === null ? "not signed in" : `not signed in on ${machineName}`;
    case "credential-missing":
      return loginMethod === "create-token" ? "no token" : "no key";
    case "token-expired":
      return "expired";
    case "harness-missing":
      return `${harnessName} is not on ${machineName ?? "any machine"}`;
    case "harness-too-old":
      return machineName === null
        ? `${harnessName} is too old`
        : `${harnessName} on ${machineName} is too old`;
    case "harness-not-allowed":
      return `${harnessName} isn't allowed for this account`;
    case "no-runner":
      return "no machine is connected";
    case "model-left-catalog":
      return "no longer offered";
    case "harness-lacks-model":
      return `${harnessName} does not offer it`;
  }
};
