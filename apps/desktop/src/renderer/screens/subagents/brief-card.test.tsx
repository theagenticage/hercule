/**
 * Tests `BriefCard`: the top line names the parent and the agent type, and
 * the brief stays cut to three lines until the user clicks it.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Subagent } from "@hercule/contract";
import { BriefCard } from "./brief-card";

const PARENT: Subagent = {
  sessionId: "ses_1",
  id: "toolu_a",
  description: "Map the webhook tests",
  agentType: "Explore",
  status: "running",
  startedAt: "2026-10-05T09:00:00.000Z",
  toolCalls: 0,
};

const CHILD: Subagent = {
  sessionId: "ses_1",
  id: "toolu_b",
  description: "Read the retry test",
  parentSubagentId: "toolu_a",
  status: "running",
  startedAt: "2026-10-05T09:01:00.000Z",
  toolCalls: 0,
};

describe("BriefCard", () => {
  it("names the main agent and the agent type of a subagent the thread spawned", () => {
    const { container } = render(
      <BriefCard subagent={PARENT} subagents={[PARENT]} brief="Find the flaky test." />,
    );
    expect(container.querySelector(".brief-card-source")?.textContent).toBe(
      "Brief from the main agent · Explore agent",
    );
  });

  it("names the parent subagent, and leaves out the agent type when there is none", () => {
    const { container } = render(
      <BriefCard subagent={CHILD} subagents={[PARENT, CHILD]} brief="Read it." />,
    );
    expect(container.querySelector(".brief-card-source")?.textContent).toBe(
      "Brief from Map the webhook tests",
    );
  });

  it("cuts the brief to three lines until it is clicked, and again on the next click", async () => {
    render(<BriefCard subagent={PARENT} subagents={[PARENT]} brief="Find the flaky test." />);
    const text = screen.getByRole("button", { name: "Find the flaky test." });
    expect(text.getAttribute("aria-expanded")).toBe("false");
    expect(text.classList.contains("is-clamped")).toBe(true);

    await userEvent.click(text);
    expect(text.getAttribute("aria-expanded")).toBe("true");
    expect(text.classList.contains("is-clamped")).toBe(false);

    await userEvent.click(text);
    expect(text.classList.contains("is-clamped")).toBe(true);
  });

  it("shows the top line alone while the brief is not known", () => {
    render(<BriefCard subagent={PARENT} subagents={[PARENT]} brief={undefined} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
