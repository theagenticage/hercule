/** Tests the words of linking a thing to a Task and of removing the link. */
import { describe, expect, it } from "vitest";
import {
  describeTaskLinkDone,
  describeTaskLinkFailure,
  describeTaskLinkGesture,
  describeTaskLinkNothing,
  reverseTaskLinkDirection,
} from "./task-links";

const THING = "#412";
const TITLE = "Restore a basket after sign-in";

describe("the words of a link on a Task", () => {
  it("reverses a link by removing it and a removal by linking", () => {
    expect(reverseTaskLinkDirection("link")).toBe("unlink");
    expect(reverseTaskLinkDirection("unlink")).toBe("link");
  });

  it("names the thing and the Task in the gesture Undo reports", () => {
    expect(describeTaskLinkGesture("link", THING, TITLE)).toBe(`Linked #412 to ${TITLE}`);
    expect(describeTaskLinkGesture("unlink", THING, TITLE)).toBe(
      `Removed the link from ${TITLE} to #412`,
    );
  });

  it("says a removed link stays removed, and a new one only that it was linked", () => {
    expect(describeTaskLinkDone("link", THING, TITLE)).toBe(`Linked #412 to ${TITLE}.`);
    expect(describeTaskLinkDone("unlink", THING, TITLE)).toBe(
      `Removed #412 from ${TITLE}. It stays removed until you link it again.`,
    );
  });

  it("says a change found nothing to do, without a word about what was done", () => {
    expect(describeTaskLinkNothing("link", THING, TITLE)).toBe(
      `#412 was linked to ${TITLE} already, so nothing changed.`,
    );
    expect(describeTaskLinkNothing("unlink", THING, TITLE)).toBe(
      `#412 was not linked to ${TITLE}, so nothing was removed.`,
    );
  });

  it("gives the reason of a refusal and says to try again", () => {
    expect(describeTaskLinkFailure("link", THING, TITLE, "No such Task")).toBe(
      `#412 was not linked to ${TITLE}: No such Task. Try again.`,
    );
    expect(describeTaskLinkFailure("unlink", THING, TITLE, "No such Task")).toBe(
      `The link from ${TITLE} to #412 was not removed: No such Task. Try again.`,
    );
  });
});
