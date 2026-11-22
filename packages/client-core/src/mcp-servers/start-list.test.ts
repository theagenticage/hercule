import { describe, expect, it } from "vitest";
import { buildProject } from "../threads/workspaces.testing";
import {
  canResetToStart,
  decideThreadStartSource,
  describeStartLine,
  describeThreadStartFoot,
  listKnownServerIds,
  type StartProjectRecord,
  type StartRecord,
} from "./start-list";
import { LINEAR, SENTRY_HOBBY, SENTRY_WORK, buildViews } from "./testing";

const VIEWS = buildViews([SENTRY_WORK, SENTRY_HOBBY, LINEAR]);
const WEBSHOP = { ...buildProject("p-shop", "webshop"), mcpServerIds: ["s-work"] };

describe("listKnownServerIds", () => {
  it("drops the ids no server has and keeps the order of the rest", () => {
    expect(listKnownServerIds(["s-linear", "s-gone", "s-work"], VIEWS)).toEqual([
      "s-linear",
      "s-work",
    ]);
    expect(listKnownServerIds(["s-gone"], VIEWS)).toEqual([]);
  });
});

describe("canResetToStart", () => {
  const start = (mcpServerIds: string[], complete = true) => ({
    mcpServerIds,
    source: { kind: "default" } as const,
    complete,
  });

  it("is true only for a complete start list that holds other ids, whatever their order", () => {
    expect(canResetToStart(start(["s-linear", "s-work"]), ["s-work"])).toBe(true);
    expect(canResetToStart(start(["s-linear", "s-work"]), ["s-work", "s-linear"])).toBe(false);
    expect(canResetToStart(start(["s-linear"], false), [])).toBe(false);
  });
});

describe("describeStartLine", () => {
  it("words the foot line and the reset button for each source", () => {
    const line = (source: Parameters<typeof describeStartLine>[0]["source"]) =>
      describeStartLine({ mcpServerIds: [], source, complete: true });

    expect(line({ kind: "project", projectName: "webshop" })).toEqual({
      line: "Starts from webshop's list. Changes are for this thread only.",
      resetLabel: "Back to webshop's list",
    });
    expect(line({ kind: "default" })).toEqual({
      line: "Starts from the default list. Changes are for this thread only.",
      resetLabel: "Back to the default list",
    });
    expect(line({ kind: "none" })).toEqual({
      line: "A thread in no project starts with no servers. Switch on what this one needs.",
      resetLabel: "Switch all off",
    });
  });
});

describe("decideThreadStartSource", () => {
  const KNOWN = new Set(["s-work", "s-linear"]);
  const read = <Value>(value: Value): StartRecord<Value> => ({ kind: "read", value });
  const decide = (
    projectId: string | null,
    project: StartProjectRecord,
    defaultIds: StartRecord<readonly string[]>,
  ) => decideThreadStartSource({ projectId, project, defaultIds, knownServerIds: KNOWN });

  it("starts from the project's record, and from the default list for a thread in no project", () => {
    expect(decide("p-shop", read(WEBSHOP), { kind: "pending" })).toEqual({
      kind: "start",
      start: {
        mcpServerIds: ["s-work"],
        source: { kind: "project", projectName: "webshop" },
        complete: true,
      },
    });
    expect(decide(null, { kind: "pending" }, read(["s-linear"]))).toEqual({
      kind: "start",
      start: { mcpServerIds: ["s-linear"], source: { kind: "default" }, complete: true },
    });
  });

  it("says why there is no start list while a record is pending, failed or missing", () => {
    expect(decide("p-shop", { kind: "pending" }, read([]))).toEqual({ kind: "pending" });
    expect(decide("p-shop", { kind: "missing" }, read([]))).toEqual({ kind: "missing" });
    expect(decide(null, read(WEBSHOP), { kind: "failed", message: "no token" })).toEqual({
      kind: "failed",
      message: "no token",
    });
  });

  it("starts from a project's list even when it is empty, and not from the default", () => {
    expect(decide("p-empty", read(buildProject("p-empty", "empty")), read(["s-linear"]))).toEqual({
      kind: "start",
      start: {
        mcpServerIds: [],
        source: { kind: "project", projectName: "empty" },
        complete: true,
      },
    });
  });

  it("has no source for a thread in no project whose default list is empty, or names only deleted servers", () => {
    expect(decide(null, { kind: "pending" }, read([]))).toMatchObject({
      start: { source: { kind: "none" }, complete: true },
    });
    expect(decide(null, { kind: "pending" }, read(["s-gone"]))).toMatchObject({
      start: { mcpServerIds: [], source: { kind: "none" }, complete: false },
    });
  });

  it("needs only the record of its source: a thread in a project ignores the default list", () => {
    expect(decide("p-shop", read(WEBSHOP), { kind: "failed", message: "no token" }).kind).toBe(
      "start",
    );
  });

  it("is incomplete from the raw ids, with the unknown ones left out", () => {
    const shop = { ...WEBSHOP, mcpServerIds: ["s-new", "s-work"] };

    expect(decide("p-shop", read(shop), { kind: "pending" })).toMatchObject({
      start: { mcpServerIds: ["s-work"], complete: false },
    });
  });
});

describe("describeThreadStartFoot", () => {
  const start = (mcpServerIds: string[], complete = true) =>
    ({
      kind: "start",
      start: { mcpServerIds, source: { kind: "project", projectName: "webshop" }, complete },
    }) as const;

  it("says where the list started, and offers the way back only while the list differs", () => {
    expect(describeThreadStartFoot(start(["s-linear"]), ["s-linear"])).toEqual({
      foot: "Starts from webshop's list. Changes are for this thread only.",
      reset: null,
    });
    expect(describeThreadStartFoot(start(["s-linear"]), []).reset).toEqual({
      label: "Back to webshop's list",
    });
  });

  it("offers no way back while the start list holds a server the catalogue does not know yet", () => {
    expect(describeThreadStartFoot(start(["s-linear"], false), []).reset).toBeNull();
  });

  it("words the foot from the reason when there is no start list, and offers no way back", () => {
    expect(describeThreadStartFoot({ kind: "pending" }, [])).toEqual({
      foot: "Reading where this list started…",
      reset: null,
    });
    expect(describeThreadStartFoot({ kind: "failed", message: "no token" }, [])).toEqual({
      foot: "Where this list started could not be read (no token). Changes are for this thread only.",
      reset: null,
    });
    expect(describeThreadStartFoot({ kind: "missing" }, []).reset).toBeNull();
  });
});
