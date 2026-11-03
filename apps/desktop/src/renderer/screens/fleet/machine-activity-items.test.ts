import { describe, expect, it } from "vitest";
import type {
  MachineActivityDay,
  MachineActivityEntry,
} from "@hercule/client-core/machine-activity";
import { buildMachineActivityItems } from "./machine-activity-items";

const buildEntry = (key: string, memberCount: number): MachineActivityEntry => ({
  key,
  time: "09:12",
  category: "sessions",
  problem: false,
  sentence: memberCount === 1 ? "Session spawned" : `${String(memberCount)} sessions spawned`,
  actor: { kind: "system" },
  members: Array.from({ length: memberCount }, (_, index) => ({
    eventId: Number(key) * 100 + index,
    time: "09:12",
    line: "Session spawned",
  })),
});

const DAYS: ReadonlyArray<MachineActivityDay> = [
  { key: "2026-11-03", heading: "Today", entries: [buildEntry("5", 3), buildEntry("4", 1)] },
  { key: "2026-11-02", heading: "Yesterday", entries: [buildEntry("2", 1)] },
];

describe("buildMachineActivityItems", () => {
  it("lists each day's heading, then its entries", () => {
    const items = buildMachineActivityItems(DAYS, new Set());

    expect(items.map((item) => item.key)).toEqual([
      "day:2026-11-03",
      "entry:5",
      "entry:4",
      "day:2026-11-02",
      "entry:2",
    ]);
  });

  it("joins an entry to the line above it, except the first of a day", () => {
    const items = buildMachineActivityItems(DAYS, new Set());

    expect(items.flatMap((item) => (item.kind === "entry" ? [item.joinsAbove] : []))).toEqual([
      false,
      true,
      false,
    ]);
  });

  it("lists the members of an open entry as lines of their own, right after it", () => {
    const items = buildMachineActivityItems(DAYS, new Set(["5"]));

    expect(items.map((item) => item.key)).toEqual([
      "day:2026-11-03",
      "entry:5",
      "member:5:500",
      "member:5:501",
      "member:5:502",
      "entry:4",
      "day:2026-11-02",
      "entry:2",
    ]);
  });

  it("opens only an entry that folded several, whatever the keys say", () => {
    const items = buildMachineActivityItems(DAYS, new Set(["4"]));

    expect(items.some((item) => item.kind === "member")).toBe(false);
  });
});
