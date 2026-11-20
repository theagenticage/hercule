import { describe, expect, it } from "vitest";
import { decideCallRefusal, isServable, type ServerUnavailableReason } from "./catalogue";
import { decideLeftOutReason, type StartDelivery } from "./left-out";
import { buildMcpServerView, type ViewFacts } from "./testing";

const CAN_DELIVER: StartDelivery = {
  runnerReachesMcpServers: true,
  harnessPassthrough: "native",
  profileGrantsMcpUse: true,
};

/**
 * The three verdicts on the same facts. Each row is one state of a server, and
 * says whether `tools/list` shows it, why a call to it is refused and why a
 * start leaves it out.
 */
describe("the verdicts of the catalogue view", () => {
  it.each<{
    readonly name: string;
    readonly facts: ViewFacts;
    readonly servable: boolean;
    readonly refusedFor: ServerUnavailableReason | null;
    readonly leftOutFor: ServerUnavailableReason | null;
  }>([
    {
      name: "a healthy server is listed, called and delivered",
      facts: {},
      servable: true,
      refusedFor: null,
      leftOutFor: null,
    },
    {
      name: "a switched-off server is not listed, and its calls and its start give the same reason",
      facts: { enabled: false },
      servable: false,
      refusedFor: "switched-off",
      leftOutFor: "switched-off",
    },
    {
      name: "a server with no stored list yet is not listed, and says it is still being checked",
      facts: { status: "checking", checkedAt: null },
      servable: false,
      refusedFor: "checking",
      leftOutFor: "checking",
    },
    {
      name: "a server that needs sign-in stays listed while its calls are refused",
      facts: { status: "needs-sign-in", connection: "needs-reauth" },
      servable: true,
      refusedFor: "needs-sign-in",
      leftOutFor: "needs-sign-in",
    },
    {
      name: "a server whose Connection is switched off is not listed",
      facts: { connection: "disabled" },
      servable: false,
      refusedFor: "error",
      leftOutFor: "error",
    },
    {
      name: "a server whose Connection is gone is not listed",
      facts: { connection: "gone" },
      servable: false,
      refusedFor: "error",
      leftOutFor: "error",
    },
    {
      name: "a server whose plugin is switched off is not listed",
      facts: { plugin: "switched-off" },
      servable: false,
      refusedFor: "error",
      leftOutFor: "error",
    },
    {
      name: "a server whose stored status is unreachable stays listed",
      facts: { status: "unreachable" },
      servable: true,
      refusedFor: "unreachable",
      leftOutFor: "unreachable",
    },
    {
      name: "a server whose stored status is error stays listed",
      facts: { status: "error" },
      servable: true,
      refusedFor: "error",
      leftOutFor: "error",
    },
    {
      name: "a server switched on again is still checking at a start, but its Connection's cause comes first for a call",
      facts: { status: "checking", connection: "needs-reauth" },
      servable: true,
      refusedFor: "needs-sign-in",
      leftOutFor: "checking",
    },
    {
      name: "a server whose Connection is of another type than its plugin needs is refused a call but not left out",
      facts: { connectionType: "other/desk" },
      servable: true,
      refusedFor: "error",
      leftOutFor: null,
    },
  ])("$name", ({ facts, servable, refusedFor, leftOutFor }) => {
    const view = buildMcpServerView(facts);

    expect(isServable(view)).toBe(servable);
    expect(decideCallRefusal(view)?.reason ?? null).toBe(refusedFor);
    expect(decideLeftOutReason(CAN_DELIVER, view)).toBe(leftOutFor);
  });

  it("tells the agent what the user can do, and says what is wrong when a plugin or Connection is the cause", () => {
    expect(decideCallRefusal(buildMcpServerView({ connection: "needs-reauth" }))?.message).toBe(
      "desk needs sign-in. Ask the user to reconnect it in Settings > Connections.",
    );
    expect(decideCallRefusal(buildMcpServerView({ connection: "disabled" }))?.message).toBe(
      "desk is not available: The Connection work is switched off.",
    );
    expect(decideCallRefusal(buildMcpServerView({ plugin: "switched-off" }))?.message).toBe(
      "desk is not available: The Desk plugin is switched off.",
    );
    expect(decideCallRefusal(buildMcpServerView({ status: "unreachable" }))?.message).toBe(
      "desk could not be reached. Try again later.",
    );
  });
});
