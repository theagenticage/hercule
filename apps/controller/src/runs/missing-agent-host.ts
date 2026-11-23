import { findRunnerRefusal, type AccountRunners } from "../provider-accounts";

/** An Agent a run's steps name, with where its provider account can run in its harness. */
export interface AgentHosts {
  readonly agentName: string;
  readonly available: AccountRunners;
}

/** Turns a refusal into a sentence: a capital first letter and a full stop. */
const buildSentence = (text: string): string =>
  `${text.charAt(0).toUpperCase()}${text.slice(1)}${text.endsWith(".") ? "" : "."}`;

/**
 * Describes why none of the runners `candidateIds` can host a run's agent
 * steps, as the message the run fails with. `agents` are every Agent the
 * run's steps name.
 *
 * For each Agent that no candidate can run, the message names the Agent and
 * says what stops it on each candidate, such as "Codex on beelink is older
 * than Hercule supports; update it to 0.171.0 or newer.". A reason that is
 * the same on every candidate, such as an expired key, is said once. When
 * every Agent has a candidate but no candidate can run them all, the message
 * says that instead.
 *
 * Expects `candidateIds` not to be empty, and no candidate to run every Agent.
 */
export const describeMissingAgentHost = (
  agents: ReadonlyArray<AgentHosts>,
  candidateIds: ReadonlyArray<string>,
): string => {
  const hostedByNone = agents.filter(({ available }) =>
    candidateIds.every((id) => !available.runnerIds.includes(id)),
  );
  if (hostedByNone.length === 0) {
    const names = agents.map(({ agentName }) => agentName).join(" and ");
    return `No machine that can take this run can run all of ${names}: each runs on a different machine. Make one machine able to run all of them, then start the run again.`;
  }
  const paragraphs = hostedByNone.map(({ agentName, available }) => {
    const reasons = new Set(
      candidateIds.map((id) => buildSentence(findRunnerRefusal(available, id) ?? "")),
    );
    return [`No machine that can take this run can run ${agentName}.`, ...reasons].join(" ");
  });
  return `${paragraphs.join(" ")} Fix that, then start the run again.`;
};
