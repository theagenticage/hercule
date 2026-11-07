import { describe, expect, it } from "vitest";
import { buildCard, FAILURE, QUESTION } from "./cards.testing";
import { chooseCardColleaguePose } from "./card-pose";

describe("chooseCardColleaguePose", () => {
  it("is working, with the live session, for a card an agent works on", () => {
    expect(chooseCardColleaguePose(buildCard("a", { workingSessionId: "s-live" }))).toEqual({
      pose: "working",
      sessionId: "s-live",
    });
  });

  it("is waiting, with the session that asks, for a card with a question", () => {
    expect(
      chooseCardColleaguePose(
        buildCard("a", { openQuestion: QUESTION, workingSessionId: "s-live" }),
      ),
    ).toEqual({ pose: "waiting", sessionId: "session-1" });
  });

  it("is failed, and a failure outranks a question and a live session", () => {
    expect(
      chooseCardColleaguePose(
        buildCard("a", { failure: FAILURE, openQuestion: QUESTION, workingSessionId: "s-live" }),
      ),
    ).toEqual({ pose: "failed", sessionId: "s-live" });
  });

  it("gives a failed card the face of the session that asked, else of its newest session", () => {
    expect(
      chooseCardColleaguePose(buildCard("a", { failure: FAILURE, openQuestion: QUESTION })),
    ).toEqual({ pose: "failed", sessionId: "session-1" });
    expect(
      chooseCardColleaguePose(buildCard("a", { failure: FAILURE, openSessionId: "s-newest" })),
    ).toEqual({ pose: "failed", sessionId: "s-newest" });
  });

  it("is nobody for a card with no session to stand for", () => {
    expect(chooseCardColleaguePose(buildCard("a"))).toBeNull();
    expect(chooseCardColleaguePose(buildCard("a", { failure: FAILURE }))).toBeNull();
  });
});
