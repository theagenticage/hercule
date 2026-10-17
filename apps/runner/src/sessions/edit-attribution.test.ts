import { describe, expect, it } from "vitest";
import { attributeChangedFiles, type CommandWindow } from "./edit-attribution";

const file = (name: string, ctimeNs: bigint | null) => ({ name, ctimeNs });
const window = (sessionId: string, startNs: bigint, endNs: bigint | undefined): CommandWindow => ({
  sessionId,
  startNs,
  endNs,
});

/** Attributes the files and returns the result by name: `session:file` for a credited file. */
const attributeNamedFiles = (
  files: ReadonlyArray<ReturnType<typeof file>>,
  windows: ReadonlyArray<CommandWindow>,
  previousListingStartedAtNs = 0n,
  scannedAtNs = 1_000_000_000n,
) => {
  const result = attributeChangedFiles(files, windows, { previousListingStartedAtNs, scannedAtNs });
  return {
    credited: result.credited.map(({ file: { name }, sessionId }) => `${sessionId}:${name}`),
    ambiguous: result.ambiguous.map(({ file: { name }, sessionIds }) => [
      name,
      [...sessionIds].sort(),
    ]),
    unattributed: result.unattributed.map(({ name }) => name),
  };
};

describe("a file with a ctime", () => {
  it("goes to the one session whose window holds it", () => {
    expect(attributeNamedFiles([file("a", 15n)], [window("A", 10n, 20n)])).toEqual({
      credited: ["A:a"],
      ambiguous: [],
      unattributed: [],
    });
  });

  it("goes to each session that holds its own files when windows overlap but ctimes do not", () => {
    const windows = [window("A", 10n, 30n), window("B", 20n, 40n)];
    expect(attributeNamedFiles([file("a", 15n), file("b", 35n)], windows).credited).toEqual([
      "A:a",
      "B:b",
    ]);
  });

  it("is ambiguous when windows of two sessions hold it", () => {
    const windows = [window("A", 10n, 30n), window("B", 20n, 40n)];
    expect(attributeNamedFiles([file("both", 25n)], windows)).toEqual({
      credited: [],
      ambiguous: [["both", ["A", "B"]]],
      unattributed: [],
    });
  });

  it("is unattributed when no window holds it", () => {
    expect(attributeNamedFiles([file("a", 5n), file("b", 21n)], [window("A", 10n, 20n)])).toEqual({
      credited: [],
      ambiguous: [],
      unattributed: ["a", "b"],
    });
  });

  it("is held by a window that ties with it at either end", () => {
    const windows = [window("A", 10n, 20n)];
    expect(attributeNamedFiles([file("start", 10n), file("end", 20n)], windows).credited).toEqual([
      "A:start",
      "A:end",
    ]);
  });

  it("is ambiguous when it ties with the end of one session's window and the start of another's", () => {
    const windows = [window("A", 10n, 20n), window("B", 20n, 30n)];
    expect(attributeNamedFiles([file("tie", 20n)], windows).ambiguous).toEqual([
      ["tie", ["A", "B"]],
    ]);
  });

  it("goes to one session when that session has two windows that hold it", () => {
    const windows = [window("A", 10n, 30n), window("A", 20n, 40n)];
    expect(attributeNamedFiles([file("a", 25n)], windows).credited).toEqual(["A:a"]);
  });

  it("is held by a window that has not ended, from its start on", () => {
    const windows = [window("A", 10n, undefined)];
    expect(attributeNamedFiles([file("later", 1_000_000n), file("earlier", 9n)], windows)).toEqual({
      credited: ["A:later"],
      ambiguous: [],
      unattributed: ["earlier"],
    });
  });

  it("is ambiguous between an open window and a closed window of another session", () => {
    const windows = [window("A", 10n, undefined), window("B", 20n, 30n)];
    expect(attributeNamedFiles([file("x", 25n)], windows).ambiguous).toEqual([["x", ["A", "B"]]]);
  });

  it("is held by a window with an unknown start, which holds everything up to its end", () => {
    const windows = [window("A", 0n, 20n)];
    expect(attributeNamedFiles([file("early", 1n), file("late", 21n)], windows)).toEqual({
      credited: ["A:early"],
      ambiguous: [],
      unattributed: ["late"],
    });
  });

  it("is ambiguous when a window with an unknown start overlaps another session's window", () => {
    const windows = [window("A", 0n, 50n), window("B", 20n, 30n)];
    expect(attributeNamedFiles([file("x", 25n), file("y", 40n)], windows)).toEqual({
      credited: ["A:y"],
      ambiguous: [["x", ["A", "B"]]],
      unattributed: [],
    });
  });
});

describe("a deleted file", () => {
  const deleted = file("gone", null);

  it("goes to the one session with a window that overlaps the time since the previous listing", () => {
    const windows = [window("A", 50n, 60n), window("B", 10n, 20n)];
    expect(attributeNamedFiles([deleted], windows, 40n).credited).toEqual(["A:gone"]);
  });

  it("counts a window that ends exactly at the start of the previous listing", () => {
    expect(attributeNamedFiles([deleted], [window("A", 10n, 40n)], 40n).credited).toEqual([
      "A:gone",
    ]);
  });

  it("counts a window that has not ended", () => {
    expect(attributeNamedFiles([deleted], [window("A", 10n, undefined)], 40n).credited).toEqual([
      "A:gone",
    ]);
  });

  it("is ambiguous when two sessions had a window since the previous listing", () => {
    const windows = [window("A", 50n, 60n), window("B", 55n, undefined)];
    expect(attributeNamedFiles([deleted], windows, 40n).ambiguous).toEqual([["gone", ["A", "B"]]]);
  });

  it("is unattributed when no session had a window since the previous listing", () => {
    expect(attributeNamedFiles([deleted], [window("A", 10n, 39n)], 40n).unattributed).toEqual([
      "gone",
    ]);
  });

  it("goes to one session when that session has several windows since the previous listing", () => {
    const windows = [window("A", 50n, 60n), window("A", 70n, undefined)];
    expect(attributeNamedFiles([deleted], windows, 40n).credited).toEqual(["A:gone"]);
  });

  it("is not held by a window that started after this listing read the files", () => {
    // The file was gone by 80, so a command that started at 90 cannot have deleted it.
    const windows = [window("A", 50n, 60n), window("B", 90n, undefined)];
    expect(attributeNamedFiles([deleted], windows, 40n, 80n).credited).toEqual(["A:gone"]);
  });

  it("counts a window that starts exactly when this listing read the files", () => {
    expect(
      attributeNamedFiles([deleted], [window("A", 80n, undefined)], 40n, 80n).credited,
    ).toEqual(["A:gone"]);
  });
});

describe("a file with a ctime from before the previous listing started", () => {
  // `mv old-dir new-dir` keeps the ctime of each file inside the directory.
  const moved = file("new-dir/f.txt", 15n);

  it("goes to the one session with a window since the previous listing, not to the one that wrote it", () => {
    const windows = [window("B", 10n, 20n), window("A", 50n, 60n)];
    expect(attributeNamedFiles([moved], windows, 40n).credited).toEqual(["A:new-dir/f.txt"]);
  });

  it("is ambiguous when two sessions had a window since the previous listing", () => {
    const windows = [window("B", 10n, undefined), window("A", 50n, 60n)];
    expect(attributeNamedFiles([moved], windows, 40n).ambiguous).toEqual([
      ["new-dir/f.txt", ["A", "B"]],
    ]);
  });

  it("counts as written at its ctime when that ctime ties with the previous listing's start", () => {
    const windows = [window("B", 10n, 40n), window("A", 50n, 60n)];
    expect(attributeNamedFiles([file("f", 40n)], windows, 40n).credited).toEqual(["B:f"]);
  });

  it("goes to its writer, a known limit, when it was written after the previous listing started", () => {
    // B wrote the file at 45, inside a window that is still open, and A moved
    // it at 55. The ctime is still 45, so B's window alone holds it.
    const windows = [window("B", 42n, undefined), window("A", 50n, 60n)];
    expect(attributeNamedFiles([file("new-dir/f.txt", 45n)], windows, 40n).credited).toEqual([
      "B:new-dir/f.txt",
    ]);
  });
});
