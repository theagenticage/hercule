import { describe, expect, it } from "vitest";
import { findMigrationProblems, parseNameStatusLine } from "./check-migrations";

const DIR = "apps/controller/src/db/migrations";

describe("parseNameStatusLine", () => {
  it("splits a rename into the original path and the destination", () => {
    expect(parseNameStatusLine(`R100\t${DIR}/0055-attachments.ts\t${DIR}/index.ts`)).toEqual({
      status: "R100",
      source: `${DIR}/0055-attachments.ts`,
      dest: `${DIR}/index.ts`,
    });
    expect(
      parseNameStatusLine(`R100\t${DIR}/0055-attachments.ts\t${DIR}/0055-attachments.test.ts`),
    ).toEqual({
      status: "R100",
      source: `${DIR}/0055-attachments.ts`,
      dest: `${DIR}/0055-attachments.test.ts`,
    });
    expect(
      parseNameStatusLine(`R100\t${DIR}/0055-attachments.ts\t${DIR}/0055-attachments.js`),
    ).toEqual({
      status: "R100",
      source: `${DIR}/0055-attachments.ts`,
      dest: `${DIR}/0055-attachments.js`,
    });
  });
});

describe("findMigrationProblems", () => {
  it("allows a new migration and an index.ts update", () => {
    expect(findMigrationProblems(`A\t${DIR}/0056-new.ts\nM\t${DIR}/index.ts\n`)).toEqual([]);
  });

  it("refuses a rename of a landed migration even when the destination is excluded", () => {
    for (const dest of [
      `${DIR}/index.ts`,
      `${DIR}/0055-attachments.test.ts`,
      `${DIR}/0055-attachments.js`,
    ]) {
      const messages = findMigrationProblems(`R100\t${DIR}/0055-attachments.ts\t${dest}\n`);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain(`${DIR}/0055-attachments.ts has been renamed`);
    }
  });

  it("refuses a modification and a deletion of a landed migration", () => {
    const messages = findMigrationProblems(
      `M\t${DIR}/0055-attachments.ts\nD\t${DIR}/0054-workspace-disposal-and-retention.ts\n`,
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain(`${DIR}/0055-attachments.ts has been modified`);
    expect(messages[1]).toContain(
      `${DIR}/0054-workspace-disposal-and-retention.ts has been deleted`,
    );
  });
});
