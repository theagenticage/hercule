/**
 * Tests `ProviderAccountCard`'s identity and reach: who is signed in and the
 * plan on a line each, each with its own tooltip, and where the account works
 * at the right end of the last line in each of its forms.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ProviderAccountIdentityLine, ProviderAccountReachView } from "@hercule/client-core";
import { ProviderAccountCard } from "./provider-account-card";

const SHARED: ProviderAccountReachView = {
  form: "shared",
  description: "Shared credential: works on every machine",
};

const renderAccountCard = (
  identity: ProviderAccountIdentityLine,
  reach: ProviderAccountReachView | null,
) =>
  render(
    <ProviderAccountCard
      mark={null}
      name="Anthropic"
      identity={identity}
      reach={reach}
      usage={null}
      state={{ kind: "ok" }}
      profileUse={null}
      onOpen={() => undefined}
      onFix={() => undefined}
      onUse={() => undefined}
    />,
  );

describe("ProviderAccountCard", () => {
  it("draws the identity and the plan on a line each, with the whole text as the tooltip of each", () => {
    renderAccountCard({ text: "rogier@acme.example", plan: "Claude Max" }, null);

    const lines = [...document.querySelectorAll<HTMLElement>(".pa-card-line")];
    expect(lines.map((line) => line.textContent)).toEqual(["rogier@acme.example", "Claude Max"]);
    expect(lines.map((line) => line.title)).toEqual(["rogier@acme.example", "Claude Max"]);
  });

  it("puts the reach at the end of the plan line, the last line, and not of the identity line", () => {
    renderAccountCard({ text: "rogier@acme.example", plan: "Claude Max" }, SHARED);

    const [identityLine, planLine] = [...document.querySelectorAll(".pa-card-line")];
    expect(identityLine!.querySelector('[role="img"]')).toBeNull();
    expect(planLine!.lastElementChild).toBe(screen.getByRole("img"));
  });

  it("puts the reach at the end of the only line of an account with no identity", () => {
    renderAccountCard({ text: "API key", plan: null }, SHARED);

    const lines = document.querySelectorAll(".pa-card-line");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.lastElementChild).toBe(screen.getByRole("img"));
  });

  it("draws no reach when it is not known where the account works", () => {
    renderAccountCard({ text: "rogier@acme.example", plan: null }, null);

    expect(screen.queryByRole("img")).toBeNull();
  });

  it("names the reach and gives it the same text as its tooltip", () => {
    renderAccountCard({ text: "API key", plan: null }, SHARED);

    const reach = screen.getByRole("img", { name: "Shared credential: works on every machine" });
    expect(reach.title).toBe("Shared credential: works on every machine");
    expect(reach.textContent).toBe("All");
  });

  it("draws one pip per machine, a ring for each that is not ready", () => {
    renderAccountCard(
      { text: "rogier@acme.example", plan: null },
      {
        form: "pips",
        pips: [
          { runnerId: "a", ready: true },
          { runnerId: "b", ready: false },
          { runnerId: "c", ready: true },
        ],
        description: "Ready on 2 of 3 machines. a: ready · b: not ready · c: ready",
      },
    );

    expect(document.querySelectorAll(".pa-pip:not(.is-you)")).toHaveLength(2);
    expect(document.querySelectorAll(".pa-pip.is-you")).toHaveLength(1);
  });

  it("draws the count in the attention ink only when a machine is not ready", () => {
    const buildCountReach = (needsAttention: boolean): ProviderAccountReachView => ({
      form: "count",
      count: needsAttention ? "4/5" : "5/5",
      needsAttention,
      description: "Ready on some machines",
    });
    const { rerender } = renderAccountCard({ text: "API key", plan: null }, buildCountReach(true));
    expect(screen.getByText("4/5").classList.contains("is-you")).toBe(true);

    rerender(
      <ProviderAccountCard
        mark={null}
        name="Anthropic"
        identity={{ text: "API key", plan: null }}
        reach={buildCountReach(false)}
        usage={null}
        state={{ kind: "ok" }}
        profileUse={null}
        onOpen={() => undefined}
        onFix={() => undefined}
        onUse={() => undefined}
      />,
    );
    expect(screen.getByText("5/5").classList.contains("is-you")).toBe(false);
  });

  it("says No machines for an account with none", () => {
    renderAccountCard(
      { text: "API key", plan: null },
      { form: "none", description: "No machines" },
    );

    expect(screen.getByRole("img", { name: "No machines" }).textContent).toBe("No machines");
  });
});
