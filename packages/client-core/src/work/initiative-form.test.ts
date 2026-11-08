/**
 * Tests what the Initiative sheet works out: the hue a new Initiative shows,
 * the date it stores, and the payloads it sends.
 */
import { describe, expect, it } from "vitest";
import { INITIATIVE_HUES, type Initiative, type InitiativeHue } from "@hercule/contract";
import {
  buildInitiativeCreateInput,
  buildInitiativeDraft,
  buildInitiativeUpdateInput,
  buildNewInitiativeDraft,
  chooseNewInitiativeHue,
  convertDayToTimestamp,
  putInitiative,
  readTimestampDay,
} from "./initiative-form";

const PROJECTS = [{ id: "web" }, { id: "api" }];

const buildInitiative = (overrides: Partial<Initiative> = {}): Initiative => ({
  id: "i1",
  name: "Gift card refunds",
  intent: "Refund to the card",
  hue: INITIATIVE_HUES[0],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("chooseNewInitiativeHue", () => {
  it("takes the first hue when nothing is open", () => {
    expect(chooseNewInitiativeHue([])).toBe(INITIATIVE_HUES[0]);
  });

  it("takes the hues in list order until each is used once", () => {
    expect(chooseNewInitiativeHue([{ hue: INITIATIVE_HUES[0] }])).toBe(INITIATIVE_HUES[1]);
    expect(chooseNewInitiativeHue([{ hue: INITIATIVE_HUES[0] }, { hue: INITIATIVE_HUES[1] }])).toBe(
      INITIATIVE_HUES[2],
    );
  });

  it("takes the least used hue, the first of the list on a tie, once every hue is used", () => {
    const once = INITIATIVE_HUES.map((hue) => ({ hue }));
    expect(chooseNewInitiativeHue(once)).toBe(INITIATIVE_HUES[0]);
    expect(chooseNewInitiativeHue([...once, { hue: INITIATIVE_HUES[0] }])).toBe(INITIATIVE_HUES[1]);
    // The third hue is used least, whatever the order the Initiatives came in.
    const unevenly = INITIATIVE_HUES.flatMap((hue): { hue: InitiativeHue }[] =>
      hue === INITIATIVE_HUES[2] ? [{ hue }] : [{ hue }, { hue }],
    );
    expect(chooseNewInitiativeHue(unevenly)).toBe(INITIATIVE_HUES[2]);
  });
});

describe("the target date", () => {
  it("converts a day to the start of that day in the user's time zone, and back", () => {
    const timestamp = convertDayToTimestamp("2026-03-14");

    expect(timestamp).toBeDefined();
    const start = new Date(timestamp ?? "");
    expect([start.getFullYear(), start.getMonth(), start.getDate()]).toEqual([2026, 2, 14]);
    expect([start.getHours(), start.getMinutes(), start.getSeconds()]).toEqual([0, 0, 0]);
    expect(readTimestampDay(timestamp ?? "")).toBe("2026-03-14");
  });

  it("converts nothing from an empty or incomplete field", () => {
    expect(convertDayToTimestamp("")).toBeUndefined();
    expect(convertDayToTimestamp("2026-03")).toBeUndefined();
  });
});

describe("buildNewInitiativeDraft", () => {
  it("starts empty, in the hue the Initiative will get, and in the lane it was opened from", () => {
    const draft = buildNewInitiativeDraft([{ hue: INITIATIVE_HUES[0] }], PROJECTS, "api");

    expect(draft).toEqual({
      name: "",
      intent: "",
      target: "",
      targetDay: "",
      projectId: "api",
      hue: INITIATIVE_HUES[1],
    });
  });

  it("starts with no Project when the lane's Project is not listed", () => {
    expect(buildNewInitiativeDraft([], PROJECTS, "gone").projectId).toBeNull();
    expect(buildNewInitiativeDraft([], PROJECTS, null).projectId).toBeNull();
  });
});

describe("buildInitiativeCreateInput", () => {
  it("trims the texts, leaves empty fields out and always sends the hue", () => {
    const input = buildInitiativeCreateInput({
      ...buildNewInitiativeDraft([], PROJECTS, null),
      name: "  Gift card refunds ",
    });

    expect(input).toEqual({ name: "Gift card refunds", hue: INITIATIVE_HUES[0] });
  });

  it("sends every field that is filled", () => {
    const input = buildInitiativeCreateInput({
      name: "Gift card refunds",
      intent: "Refund to the card",
      target: "Live by the spring sale",
      targetDay: "2026-03-14",
      projectId: "web",
      hue: INITIATIVE_HUES[4],
    });

    expect(input).toEqual({
      name: "Gift card refunds",
      intent: "Refund to the card",
      target: "Live by the spring sale",
      targetDate: convertDayToTimestamp("2026-03-14"),
      projectId: "web",
      hue: INITIATIVE_HUES[4],
    });
  });
});

describe("buildInitiativeUpdateInput", () => {
  const initiative = buildInitiative({
    target: "Live by spring",
    targetDate: "2026-03-14T09:30:00.000Z",
    projectId: "web",
  });
  const draft = buildInitiativeDraft(initiative, PROJECTS);

  it("returns null when nothing changed, so no empty update is sent", () => {
    expect(buildInitiativeUpdateInput(initiative, draft, PROJECTS)).toBeNull();
  });

  it("sends only the fields that changed", () => {
    expect(
      buildInitiativeUpdateInput(
        initiative,
        { ...draft, name: " Refunds ", hue: INITIATIVE_HUES[3] },
        PROJECTS,
      ),
    ).toEqual({ name: "Refunds", hue: INITIATIVE_HUES[3] });
  });

  it("does not write an untouched target date again, so its time of day stays", () => {
    const update = buildInitiativeUpdateInput(initiative, { ...draft, intent: "New" }, PROJECTS);

    expect(update).toEqual({ intent: "New" });
  });

  it("sends null for an emptied target, target date and Project", () => {
    const update = buildInitiativeUpdateInput(
      initiative,
      { ...draft, target: "  ", targetDay: "", projectId: null },
      PROJECTS,
    );

    expect(update).toEqual({ target: null, targetDate: null, projectId: null });
  });

  it("sends a new target date as the start of its day", () => {
    const update = buildInitiativeUpdateInput(
      initiative,
      { ...draft, targetDay: "2026-04-01" },
      PROJECTS,
    );

    expect(update).toEqual({ targetDate: convertDayToTimestamp("2026-04-01") });
  });

  it("shows a Project that is no longer listed as no Project, and does not write that", () => {
    const stale = buildInitiative({ projectId: "gone" });
    const staleDraft = buildInitiativeDraft(stale, PROJECTS);

    expect(staleDraft.projectId).toBeNull();
    expect(buildInitiativeUpdateInput(stale, staleDraft, PROJECTS)).toBeNull();
    expect(
      buildInitiativeUpdateInput(stale, { ...staleDraft, projectId: "api" }, PROJECTS),
    ).toEqual({
      projectId: "api",
    });
  });
});

describe("putInitiative", () => {
  const first = buildInitiative({ id: "a", createdAt: "2026-01-01T00:00:00.000Z" });
  const third = buildInitiative({ id: "c", createdAt: "2026-01-03T00:00:00.000Z" });

  it("puts a new Initiative in creation order", () => {
    const second = buildInitiative({ id: "b", createdAt: "2026-01-02T00:00:00.000Z" });
    const last = buildInitiative({ id: "d", createdAt: "2026-01-04T00:00:00.000Z" });

    expect(putInitiative([first, third], second).map((each) => each.id)).toEqual(["a", "b", "c"]);
    expect(putInitiative([first, third], last).map((each) => each.id)).toEqual(["a", "c", "d"]);
    expect(putInitiative([], first)).toEqual([first]);
  });

  it("replaces an Initiative that is listed, where it is", () => {
    const renamed = { ...first, name: "Renamed" };

    expect(putInitiative([first, third], renamed)).toEqual([renamed, third]);
  });

  it("takes a closed Initiative out of the list", () => {
    const closed = { ...first, closedAt: "2026-02-01T00:00:00.000Z" };

    expect(putInitiative([first, third], closed)).toEqual([third]);
  });
});
