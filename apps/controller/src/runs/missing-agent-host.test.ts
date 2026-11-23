/** Tests `describeMissingAgentHost`: the message a run fails with when no runner can host its Agents. */
import { describe, expect, it } from "vitest";
import type { AccountRunners } from "../provider-accounts";
import { describeMissingAgentHost } from "./missing-agent-host";

const TOO_OLD = (machine: string) =>
  `Codex on ${machine} is older than Hercule supports; update it to 0.171.0 or newer`;

/** Codex is ready on atlas only, and too old on beelink and bosgame. */
const CODEX_ON_ATLAS: AccountRunners = {
  runnerIds: ["atlas"],
  subject: "OpenAI · work in Codex",
  noRunnerMessage: null,
  refusals: new Map([
    ["beelink", TOO_OLD("beelink")],
    ["bosgame", TOO_OLD("bosgame")],
  ]),
};

describe("describeMissingAgentHost", () => {
  it("says what stops the Agent on each machine that could take the run", () => {
    expect(
      describeMissingAgentHost(
        [{ agentName: "pr-reviewer-codex", available: CODEX_ON_ATLAS }],
        ["beelink", "bosgame"],
      ),
    ).toBe(
      "No machine that can take this run can run pr-reviewer-codex. " +
        `${TOO_OLD("beelink")}. ${TOO_OLD("bosgame")}. Fix that, then start the run again.`,
    );
  });

  it("names only the Agents no machine can run, and says a reason shared by every machine once", () => {
    const expiredKey = "Z.ai's key has expired. Add a new key in Settings › Providers.";
    const keyExpired: AccountRunners = {
      runnerIds: [],
      subject: "Z.ai in pi",
      noRunnerMessage: expiredKey,
      refusals: new Map([
        ["beelink", expiredKey],
        ["bosgame", expiredKey],
      ]),
    };
    const everywhere: AccountRunners = {
      runnerIds: ["beelink", "bosgame"],
      subject: "Anthropic in Claude Code",
      noRunnerMessage: null,
      refusals: new Map(),
    };

    expect(
      describeMissingAgentHost(
        [
          { agentName: "pr-reviewer-claude", available: everywhere },
          { agentName: "pr-reviewer-glm", available: keyExpired },
        ],
        ["beelink", "bosgame"],
      ),
    ).toBe(
      `No machine that can take this run can run pr-reviewer-glm. ${expiredKey} Fix that, then start the run again.`,
    );
  });

  it("says that no one machine runs them all when each Agent runs on some machine", () => {
    const onlyBeelink: AccountRunners = { ...CODEX_ON_ATLAS, runnerIds: ["beelink"] };
    const onlyBosgame: AccountRunners = { ...CODEX_ON_ATLAS, runnerIds: ["bosgame"] };

    expect(
      describeMissingAgentHost(
        [
          { agentName: "a", available: onlyBeelink },
          { agentName: "b", available: onlyBosgame },
        ],
        ["beelink", "bosgame"],
      ),
    ).toBe(
      "No machine that can take this run can run all of a and b: each runs on a different machine. Make one machine able to run all of them, then start the run again.",
    );
  });
});
