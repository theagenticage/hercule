import { describe, expect, it } from "vitest";
import type { Session } from "@hercule/contract";
import { buildProject, buildSession } from "../threads/workspaces.testing";
import type { StartRecord } from "./start-list";
import { LINEAR, SENTRY_WORK, buildServer } from "./testing";
import {
  decideThreadServersDemand,
  describeThreadServers,
  type ThreadServersRecords,
} from "./thread-servers";

const WEBSHOP = { ...buildProject("p-shop", "webshop"), mcpServerIds: ["s-work"] };
const EMPTY = buildProject("p-empty", "empty");
const SERVERS = [SENTRY_WORK, LINEAR];

const startedWith = (ids: readonly string[], projectId: string | null = null): Session =>
  buildSession({
    id: "t-1",
    projectId,
    mcpServers: ids.map((mcpServerId) => ({ mcpServerId, name: mcpServerId, leftOut: null })),
  });

/** Returns records of a started thread with `ids` as its list, in no project, with nothing open. */
const started = (
  ids: readonly string[],
  over: Partial<ThreadServersRecords> = {},
): ThreadServersRecords => ({
  thread: { kind: "started", session: startedWith(ids) },
  project: { kind: "pending" },
  defaultIds: { kind: "read", value: [] },
  hasMcpLine: false,
  editing: false,
  ...over,
});

/** Returns records of a draft in `projectId`, with `pick` as its own list. */
const draft = (
  projectId: string | null,
  pickedIds: readonly string[] | undefined,
  over: Partial<ThreadServersRecords> = {},
): ThreadServersRecords => ({
  thread: { kind: "draft", projectId, pickedIds },
  project: projectId === null ? { kind: "pending" } : { kind: "read", value: WEBSHOP },
  defaultIds: { kind: "read", value: ["s-linear"] },
  hasMcpLine: false,
  editing: false,
  ...over,
});

describe("decideThreadServersDemand", () => {
  it("asks for nothing from a thread with no server, no line and no editor", () => {
    expect(decideThreadServersDemand(started([]))).toEqual({
      catalogue: false,
      views: false,
      start: false,
    });
  });

  it("asks for the servers alone while the list is not empty: the red dot needs no join", () => {
    expect(decideThreadServersDemand(started(["s-work"]))).toEqual({
      catalogue: true,
      views: false,
      start: false,
    });
  });

  it("asks for the servers and their join, not the start, for a thread with only a line about servers", () => {
    expect(decideThreadServersDemand(started([], { hasMcpLine: true }))).toEqual({
      catalogue: true,
      views: true,
      start: false,
    });
  });

  it("asks for everything while the editor is open, even for an empty list", () => {
    expect(decideThreadServersDemand(started([], { editing: true }))).toEqual({
      catalogue: true,
      views: true,
      start: true,
    });
  });

  it("keeps asking for the servers while a draft's pick names only servers that may be deleted", () => {
    const records = draft("p-shop", ["s-gone"]);

    // The demand comes from the stored ids, not from the shown list, which is empty once the
    // servers say none of the ids exists. So an unknown id never drops the topic.
    expect(decideThreadServersDemand(records).catalogue).toBe(true);
    expect(describeThreadServers(records, SERVERS).mcpServerIds).toEqual([]);
  });

  it("asks for nothing from a draft whose project and pick hold no server", () => {
    const records = draft("p-empty", undefined, { project: { kind: "read", value: EMPTY } });

    expect(decideThreadServersDemand(records).catalogue).toBe(false);
  });

  it("asks for the servers for a draft that starts from its project's list, and for one that starts from the default list", () => {
    expect(decideThreadServersDemand(draft("p-shop", undefined)).catalogue).toBe(true);
    expect(decideThreadServersDemand(draft(null, undefined)).catalogue).toBe(true);
  });

  it("asks for nothing from a draft whose explicit empty pick overrides a project list", () => {
    expect(decideThreadServersDemand(draft("p-shop", [])).catalogue).toBe(false);
  });
});

describe("describeThreadServers, for a started thread", () => {
  it("shows the session's own list, with the count alone until the servers are read", () => {
    const records = started(["s-work", "s-linear"]);

    expect(describeThreadServers(records, undefined)).toEqual({
      storedIds: ["s-work", "s-linear"],
      mcpServerIds: ["s-work", "s-linear"],
      row: { words: "2", failing: false },
    });
  });

  it("keeps an id no server has, because the controller drops it from the session itself", () => {
    expect(describeThreadServers(started(["s-gone", "s-work"]), SERVERS).mcpServerIds).toEqual([
      "s-gone",
      "s-work",
    ]);
  });

  it("words the row from the servers, and puts the dot on one that needs sign-in", () => {
    const signedOut = buildServer("s-work", "sentry", "c-work", { status: "needs-sign-in" });

    expect(describeThreadServers(started(["s-work"]), [signedOut, LINEAR]).row).toEqual({
      words: "1 needs sign-in",
      failing: true,
    });
  });

  it("keeps a started thread's own list whatever its start records say", () => {
    const failed: StartRecord<never> = { kind: "failed", message: "offline" };
    const inShop = started(["s-work"], {
      thread: { kind: "started", session: startedWith(["s-work"], "p-shop") },
      project: failed,
    });

    expect(describeThreadServers(inShop, SERVERS).mcpServerIds).toEqual(["s-work"]);
  });
});

describe("describeThreadServers, for a draft", () => {
  it("shows the list it starts from while it holds no pick: its project's list", () => {
    expect(describeThreadServers(draft("p-shop", undefined), SERVERS)).toMatchObject({
      storedIds: ["s-work"],
      mcpServerIds: ["s-work"],
      row: { words: "1", failing: false },
    });
  });

  it("starts a draft in no project from the default list, without servers deleted since", () => {
    const records = draft(null, undefined, {
      defaultIds: { kind: "read", value: ["s-gone", "s-linear"] },
    });

    expect(describeThreadServers(records, undefined).mcpServerIds).toEqual(["s-gone", "s-linear"]);
    expect(describeThreadServers(records, SERVERS).mcpServerIds).toEqual(["s-linear"]);
  });

  it("shows the pick, even an explicit empty one over a project's list", () => {
    const records = draft("p-shop", []);

    expect(describeThreadServers(records, SERVERS)).toMatchObject({
      storedIds: [],
      mcpServerIds: [],
      row: { words: "none" },
    });
  });

  it("shows a pick without the servers deleted since once the servers are read, and as picked before", () => {
    const records = draft("p-shop", ["s-linear", "s-gone"]);

    expect(describeThreadServers(records, undefined).mcpServerIds).toEqual(["s-linear", "s-gone"]);
    expect(describeThreadServers(records, SERVERS).mcpServerIds).toEqual(["s-linear"]);
  });

  it("shows no servers while the project's record is not read or could not be read", () => {
    for (const project of [
      { kind: "pending" },
      { kind: "failed", message: "offline" },
      { kind: "missing" },
    ] as const) {
      expect(describeThreadServers(draft("p-shop", undefined, { project }), SERVERS)).toMatchObject(
        { storedIds: [], mcpServerIds: [] },
      );
    }
  });
});
