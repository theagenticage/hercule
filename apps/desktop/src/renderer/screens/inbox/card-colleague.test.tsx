/** Tests how a card draws and names the colleague that has it. */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildLook, Face } from "../../faces";
import { CardColleague } from "./card-moves";

describe("a card's colleague", () => {
  it("is named by the workflow that has the card", () => {
    render(<CardColleague workflow={{ workflowId: "wf-agent-review", name: "Agent review" }} />);
    expect(screen.getByRole("img", { name: "Agent review has it" })).toBeTruthy();
  });

  it("draws the face of the workflow's id, as the hand-off button, the menu and the rail do", () => {
    const { container: expected } = render(
      <Face look={buildLook("wf-agent-review")} pose="working" size={22} />,
    );
    const { container } = render(
      <CardColleague workflow={{ workflowId: "wf-agent-review", name: "Any name" }} />,
    );

    expect(container.querySelector("svg")?.outerHTML).toBe(
      expected.querySelector("svg")?.outerHTML,
    );
  });
});
