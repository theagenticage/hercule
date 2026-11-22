import { describe, expect, it } from "vitest";
import { buildProject } from "../threads/workspaces.testing";
import { buildProjectBoxes, decideProjectBoxWrite, describeProjectRefusal } from "./project-boxes";
import { LINEAR, SENTRY_HOBBY, SENTRY_WORK, buildServer, buildViews } from "./testing";

const VIEWS = buildViews([SENTRY_WORK, SENTRY_HOBBY, LINEAR]);
const SERVERS = VIEWS.map((view) => view.server);
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

describe("decideProjectBoxWrite", () => {
  it("ticks by adding the server to the list as it is now", () => {
    expect(decideProjectBoxWrite(["s-linear"], SERVERS, HOBBY!.server, "tick")).toEqual({
      kind: "write",
      mcpServerIds: ["s-linear", "s-hobby"],
    });
  });

  it("refuses a tick while the list names another server of the same name", () => {
    expect(decideProjectBoxWrite(["s-work", "s-linear"], SERVERS, HOBBY!.server, "tick")).toEqual({
      kind: "refused",
      occupantId: WORK!.server.id,
    });
  });

  it("unticks by removing only the page's server, whatever else the list holds", () => {
    expect(
      decideProjectBoxWrite(["s-new", "s-hobby", "s-linear"], SERVERS, HOBBY!.server, "untick"),
    ).toEqual({ kind: "write", mcpServerIds: ["s-new", "s-linear"] });
    expect(decideProjectBoxWrite(["s-work"], SERVERS, HOBBY!.server, "untick")).toEqual({
      kind: "write",
      mcpServerIds: ["s-work"],
    });
  });

  it("swaps in the old one's place while the list still names the server the user confirmed", () => {
    expect(
      decideProjectBoxWrite(["s-work", "s-linear"], SERVERS, HOBBY!.server, { swapFrom: "s-work" }),
    ).toEqual({ kind: "write", mcpServerIds: ["s-hobby", "s-linear"] });
  });

  it("refuses a swap when the list names another occupant by now", () => {
    const threeViews = buildViews([
      SENTRY_WORK,
      SENTRY_HOBBY,
      buildServer("s-third", "sentry", "c-work"),
    ]);
    const third = threeViews[2]!;

    expect(
      decideProjectBoxWrite(
        ["s-work"],
        threeViews.map((view) => view.server),
        HOBBY!.server,
        { swapFrom: "s-third" },
      ),
    ).toEqual({ kind: "refused", occupantId: "s-work" });
    expect(third.server.id).toBe("s-third");
  });

  it("writes a swap as a tick when the list no longer names a server of that name", () => {
    expect(
      decideProjectBoxWrite(["s-linear"], SERVERS, HOBBY!.server, { swapFrom: "s-work" }),
    ).toEqual({
      kind: "write",
      mcpServerIds: ["s-linear", "s-hobby"],
    });
  });
});
