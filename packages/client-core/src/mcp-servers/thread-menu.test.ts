import { describe, expect, it } from "vitest";
import { decideThreadStartList } from "./start-list";
import {
  buildServerPicker,
  buildThreadServerMenu,
  countServersNeedingSignIn,
  orderMenuNames,
} from "./thread-menu";
import { LINEAR, SENTRY_HOBBY, SENTRY_WORK, buildServer, buildViews } from "./testing";

const START = decideThreadStartList(null, [], [], []);
const menuOf = (
  views: ReturnType<typeof buildViews>,
  mcpServerIds: string[],
  order = orderMenuNames(views, mcpServerIds),
  rememberedAccounts: Record<string, string> = {},
) => buildThreadServerMenu({ views, mcpServerIds, order, rememberedAccounts, start: START });

/** Returns `count` ready servers named `tool01`, `tool02`, ... */
const buildManyServers = (count: number) =>
  Array.from({ length: count }, (_, index) => {
    const name = `tool${String(index + 1).padStart(2, "0")}`;
    return buildServer(`s-${name}`, name, "c-linear");
  });

describe("orderMenuNames", () => {
  it("puts the thread's own names first, then the names of servers switched on in Settings", () => {
    const views = buildViews([
      buildServer("s-a", "alpha", "c-linear"),
      buildServer("s-b", "bravo", "c-linear"),
      buildServer("s-c", "charlie", "c-linear"),
    ]);

    expect(orderMenuNames(views, ["s-c"])).toEqual(["charlie", "alpha", "bravo"]);
  });

  it("leaves out a name only switched-off servers have, unless the thread has one", () => {
    const views = buildViews([
      buildServer("s-a", "alpha", "c-linear", { enabled: false }),
      buildServer("s-b", "bravo", "c-linear", { enabled: false }),
      LINEAR,
    ]);

    expect(orderMenuNames(views, [])).toEqual(["linear"]);
    expect(orderMenuNames(views, ["s-b"])).toEqual(["bravo", "linear"]);
  });

  it("lists a name once when two accounts have it", () => {
    expect(orderMenuNames(buildViews([SENTRY_WORK, SENTRY_HOBBY]), [])).toEqual(["sentry"]);
  });
});

describe("buildThreadServerMenu", () => {
  const VIEWS = buildViews([LINEAR, SENTRY_WORK, SENTRY_HOBBY]);

  it("shows one row for two accounts of a name, on with the thread's own account", () => {
    const { rows } = menuOf(VIEWS, ["s-work"]);

    expect(rows.map((row) => row.name)).toEqual(["sentry", "linear"]);
    expect(rows[0]).toMatchObject({ on: true, note: null, reconnect: null });
    expect(rows[0]?.shown.server.id).toBe("s-work");
    expect(rows[0]?.accounts.map((view) => view.server.id)).toEqual(["s-hobby", "s-work"]);
  });

  it("shows the remembered account of a name that is off, else the first", () => {
    const sentry = (remembered: Record<string, string>) =>
      menuOf(VIEWS, [], undefined, remembered).rows.find((row) => row.name === "sentry");

    expect(sentry({})).toMatchObject({ on: false });
    expect(sentry({})?.shown.server.id).toBe("s-hobby");
    expect(sentry({ sentry: "s-work" })?.shown.server.id).toBe("s-work");
  });

  it("keeps a server that needs sign-in on, and says so with the button that fixes it", () => {
    const views = buildViews([
      buildServer("s-work", "sentry", "c-work", { status: "needs-sign-in" }),
    ]);

    expect(menuOf(views, ["s-work"]).rows[0]).toMatchObject({
      on: true,
      note: "on, joins once you sign in",
      reconnect: { connectionId: "c-work", label: "Reconnect Sentry · work" },
    });
    expect(menuOf(views, []).rows[0]).toMatchObject({ on: false, note: "needs sign-in" });
  });

  it("offers a server switched off in Settings only to a thread that has it", () => {
    const views = buildViews([
      LINEAR,
      buildServer("s-work", "sentry", "c-work", { enabled: false }),
    ]);
    const order = ["sentry", "linear"];

    expect(menuOf(views, [], order).rows.map((row) => row.name)).toEqual(["linear"]);
    expect(menuOf(views, ["s-work"], order).rows.map((row) => row.name)).toEqual([
      "sentry",
      "linear",
    ]);
  });

  it("shows eight names and counts the rest, switched-off-only names included", () => {
    const views = buildViews([
      ...buildManyServers(9),
      buildServer("s-off", "zulu", "c-linear", { enabled: false }),
    ]);

    const menu = menuOf(views, []);

    expect(menu.rows).toHaveLength(8);
    expect(menu.moreCount).toBe(2);
  });

  it("shows every name of a thread that has more than eight servers", () => {
    const servers = buildManyServers(10);
    const views = buildViews(servers);
    const nine = servers.slice(0, 9).map((server) => server.id);

    const menu = menuOf(views, nine);

    expect(menu.rows).toHaveLength(9);
    expect(menu.moreCount).toBe(1);
  });

  it("keeps every row in place while the thread's list changes after the menu opened", () => {
    const servers = buildManyServers(10);
    const views = buildViews(servers);
    const nine = servers.slice(0, 9).map((server) => server.id);
    const order = orderMenuNames(views, nine);

    const afterSwitchingOff = menuOf(
      views,
      nine.filter((id) => id !== "s-tool03"),
      order,
    );

    expect(afterSwitchingOff.rows.map((row) => row.name)).toEqual(order.slice(0, 9));
  });

  it("shows a name the thread gets from the picker, though it was beyond the first eight", () => {
    const views = buildViews(buildManyServers(10));
    const order = orderMenuNames(views, []);

    const menu = menuOf(views, ["s-tool10"], order);

    expect(menu.rows.map((row) => row.name)).toContain("tool10");
  });

  it("drops the row of a name whose servers were all deleted since the menu opened", () => {
    const order = orderMenuNames(buildViews([LINEAR, SENTRY_WORK]), []);

    expect(menuOf(buildViews([LINEAR]), [], order).rows.map((row) => row.name)).toEqual(["linear"]);
  });

  it("says where the list started, and offers the way back only while the list differs", () => {
    const start = decideThreadStartList(
      "p-shop",
      [{ id: "p-shop", name: "webshop", mcpServerIds: ["s-linear"], createdAt: "", updatedAt: "" }],
      [],
      VIEWS,
    );
    const build = (mcpServerIds: string[]) =>
      buildThreadServerMenu({
        views: VIEWS,
        mcpServerIds,
        order: [],
        rememberedAccounts: {},
        start,
      });

    expect(build(["s-linear"]).foot).toBe(
      "Starts from webshop's list. Changes are for this thread only.",
    );
    expect(build(["s-linear"]).reset).toBeNull();
    expect(build([]).reset).toEqual({
      label: "Back to webshop's list",
      mcpServerIds: ["s-linear"],
    });
  });
});

describe("countServersNeedingSignIn", () => {
  it("counts only the thread's own servers that need sign-in", () => {
    const views = buildViews([
      buildServer("s-work", "sentry", "c-work", { status: "needs-sign-in" }),
      buildServer("s-hobby", "sentry", "c-hobby", { status: "needs-sign-in" }),
      buildServer("s-off", "alpha", "c-linear", { status: "needs-sign-in", enabled: false }),
      LINEAR,
    ]);

    expect(countServersNeedingSignIn(views, ["s-work", "s-off", "s-linear"])).toBe(1);
  });
});

describe("buildServerPicker", () => {
  const VIEWS = buildViews([
    LINEAR,
    SENTRY_WORK,
    SENTRY_HOBBY,
    buildServer("s-off", "alpha", "c-linear", { enabled: false }),
  ]);
  const build = (overrides: Partial<Parameters<typeof buildServerPicker>[0]> = {}) =>
    buildServerPicker({
      views: VIEWS,
      mcpServerIds: [],
      order: [],
      rememberedAccounts: {},
      filter: "",
      ...overrides,
    });

  it("offers every name, switched-off ones too, with the names missing from the order last", () => {
    expect(build({ order: ["sentry"] }).rows.map((row) => row.name)).toEqual([
      "sentry",
      "linear",
      "alpha",
    ]);
  });

  it("writes the second line, and the status word only for a server that needs the user or is off", () => {
    const { rows } = build();

    expect(rows.map((row) => [row.name, row.secondLine, row.statusWord])).toEqual([
      ["linear", "Linear Connection", null],
      ["sentry", "Sentry Connection, 2 accounts", null],
      ["alpha", "Linear Connection", "off"],
    ]);
  });

  it("counts the chosen names, and a name with two accounts once", () => {
    const picker = build({ mcpServerIds: ["s-hobby", "s-linear"] });

    expect(picker.chosenCount).toBe(2);
    expect(picker.rows.find((row) => row.name === "sentry")).toMatchObject({ chosen: true });
    expect(picker.rows.find((row) => row.name === "sentry")?.shown.server.id).toBe("s-hobby");
  });

  it("keeps showing the remembered account of a name that was switched off", () => {
    expect(
      build({ rememberedAccounts: { sentry: "s-work" } }).rows.find((row) => row.name === "sentry")
        ?.shown.server.id,
    ).toBe("s-work");
  });

  it("filters by name or account in any case, and counts every chosen name whatever the filter", () => {
    const picker = build({ mcpServerIds: ["s-linear"], filter: " WORK " });

    expect(picker.rows.map((row) => row.name)).toEqual(["sentry"]);
    expect(picker.chosenCount).toBe(1);
    expect(build({ filter: "lin" }).rows.map((row) => row.name)).toEqual(["linear"]);
  });

  it("shows the filter field only for more than eight names", () => {
    expect(build().showsFilter).toBe(false);
    expect(build({ views: buildViews(buildManyServers(8)) }).showsFilter).toBe(false);
    expect(build({ views: buildViews(buildManyServers(9)) }).showsFilter).toBe(true);
  });
});
