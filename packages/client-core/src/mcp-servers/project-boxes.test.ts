import { describe, expect, it } from "vitest";
import { buildProject } from "../threads/workspaces.testing";
import { buildProjectBoxes, describeProjectRefusal } from "./project-boxes";
import { LINEAR, SENTRY_HOBBY, SENTRY_WORK, buildViews } from "./testing";

const VIEWS = buildViews([SENTRY_WORK, SENTRY_HOBBY, LINEAR]);
const [WORK, HOBBY] = VIEWS;
const WEBSHOP = { ...buildProject("p-shop", "webshop"), mcpServerIds: ["s-work"] };
const BLOG = buildProject("p-blog", "blog");

describe("buildProjectBoxes", () => {
  it("gives one box for each project, then one for the threads without a project", () => {
    const boxes = buildProjectBoxes(HOBBY!, VIEWS, [WEBSHOP, BLOG], ["s-hobby"]);

    expect(boxes.map((box) => [box.target.kind, box.ticked])).toEqual([
      ["project", false],
      ["project", false],
      ["default", true],
    ]);
  });

  it("marks a box ticked while its list names the server", () => {
    const [shop] = buildProjectBoxes(WORK!, VIEWS, [WEBSHOP], []);

    expect(shop).toMatchObject({ ticked: true, takenBy: null });
  });

  it("names the other server of the same name that a list already uses", () => {
    const [shop, blog, fallback] = buildProjectBoxes(HOBBY!, VIEWS, [WEBSHOP, BLOG], ["s-linear"]);

    expect(shop?.takenBy?.server.id).toBe("s-work");
    expect(blog?.takenBy).toBeNull();
    expect(fallback?.takenBy).toBeNull();
  });
});

describe("describeProjectRefusal", () => {
  const [shop, blog, fallback] = buildProjectBoxes(HOBBY!, VIEWS, [WEBSHOP, BLOG], ["s-work"]);

  it("words the refusal and its two buttons, with the code spans marked", () => {
    const refusal = describeProjectRefusal(shop!, HOBBY!);

    expect(refusal?.sentence).toEqual([
      { text: "webshop", code: true },
      { text: " already uses ", code: false },
      { text: "sentry", code: true },
      { text: " ", code: false },
      { text: "work", code: true },
      {
        text: ". One project cannot name both: their tools would get the same names.",
        code: false,
      },
    ]);
    expect(refusal?.use).toEqual([
      { text: "Use ", code: false },
      { text: "sentry", code: true },
      { text: " ", code: false },
      { text: "hobby", code: true },
    ]);
    expect(refusal?.keep.map((part) => part.text).join("")).toBe("Keep sentry work");
  });

  it("has no refusal for a box that nothing blocks", () => {
    expect(describeProjectRefusal(blog!, HOBBY!)).toBeNull();
  });

  it("words the refusal of the threads-without-a-project box for a list, with the same buttons", () => {
    const refusal = describeProjectRefusal(fallback!, HOBBY!);

    expect(refusal?.sentence).toEqual([
      { text: "Threads without a project already use ", code: false },
      { text: "sentry", code: true },
      { text: " ", code: false },
      { text: "work", code: true },
      { text: ". One list cannot name both: their tools would get the same names.", code: false },
    ]);
    expect(refusal?.use.map((part) => part.text).join("")).toBe("Use sentry hobby");
    expect(refusal?.keep.map((part) => part.text).join("")).toBe("Keep sentry work");
  });
});
