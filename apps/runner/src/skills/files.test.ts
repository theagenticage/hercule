/** Tests the text cutting, the listing budget and the link walk that the skills listing shares. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  MAX_LISTING_ENTRIES,
  buildListingBudget,
  fitText,
  resolveWithinCheckout,
  shortenText,
  spendEntry,
} from "./files";

describe("fitText", () => {
  it("keeps text that fits and cuts longer text to the limit, ending in an ellipsis", () => {
    expect(fitText("abc", 5)).toBe("abc");
    expect(fitText("abcdef", 5)).toBe("ab...");
  });

  it("never splits a surrogate pair, and never exceeds the limit", () => {
    // Each emoji is two UTF-16 code units, so the cut at 3 code units falls inside the second one.
    const cut = fitText("😀😀😀😀", 6);
    expect(cut).toBe("😀...");
    expect(cut.length).toBeLessThanOrEqual(6);
  });
});

describe("shortenText", () => {
  it("keeps the first characters and adds an ellipsis only when it cut", () => {
    expect(shortenText("abc", 3)).toBe("abc");
    expect(shortenText("abcd", 3)).toBe("abc...");
    expect(shortenText("😀😀", 3)).toBe("😀...");
  });
});

describe("spendEntry", () => {
  it("spends entries until none is left, then reports the budget spent", () => {
    const budget = buildListingBudget(new AbortController().signal);
    budget.entriesLeft = 2;
    expect([spendEntry(budget), spendEntry(budget), spendEntry(budget)]).toEqual([
      true,
      true,
      false,
    ]);
    expect(budget.isSpent).toBe(true);
  });

  it("starts with the listing's limit", () => {
    expect(buildListingBudget(new AbortController().signal).entriesLeft).toBe(MAX_LISTING_ENTRIES);
  });

  it("throws the abort reason once the time is over", () => {
    const controller = new AbortController();
    const budget = buildListingBudget(controller.signal);
    controller.abort(new Error("out of time"));
    expect(() => spendEntry(budget)).toThrow("out of time");
  });
});

describe("resolveWithinCheckout", () => {
  const roots: Array<string> = [];

  afterAll(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** Makes a checkout with a folder `dir`, a file `plain` and a file `dir/actual.md`. */
  const makeCheckout = (): string => {
    // Resolved, because macOS keeps temporary files under `/var`, a link to `/private/var`.
    const checkout = realpathSync(mkdtempSync(join(tmpdir(), "hercule-files-")));
    roots.push(checkout);
    mkdirSync(join(checkout, "dir"));
    writeFileSync(join(checkout, "plain"), "x");
    writeFileSync(join(checkout, "dir/actual.md"), "x");
    return checkout;
  };

  const resolve = (checkout: string, relativePath: string) =>
    resolveWithinCheckout(
      checkout,
      checkout,
      relativePath,
      buildListingBudget(new AbortController().signal),
    );

  it("refuses a path that continues past a file, as the file system does, instead of shortening it", async () => {
    const checkout = makeCheckout();
    const problem = { problem: "goes through `plain`, which is not a folder" };

    await expect(resolve(checkout, "plain/../dir")).resolves.toEqual(problem);
    await expect(resolve(checkout, "plain/x")).resolves.toEqual(problem);
    await expect(resolve(checkout, "plain/")).resolves.toEqual(problem);
    await expect(resolve(checkout, "plain/.")).resolves.toEqual(problem);
    // Through a link, the file is reached by the link's target.
    symlinkSync("plain/../dir/actual.md", join(checkout, "link"));
    await expect(resolve(checkout, "link")).resolves.toEqual(problem);
  });

  it("accepts a trailing slash and a `..` after a folder, and a file as the last component", async () => {
    const checkout = makeCheckout();

    await expect(resolve(checkout, "dir/")).resolves.toMatchObject({
      path: join(checkout, "dir"),
      isFolder: true,
    });
    await expect(resolve(checkout, "dir/../plain")).resolves.toMatchObject({
      path: join(checkout, "plain"),
      isFolder: false,
    });
  });

  it("returns the same identity for every path that reaches one folder, and another for another folder", async () => {
    const checkout = makeCheckout();
    mkdirSync(join(checkout, "other"));
    symlinkSync("dir", join(checkout, "alias"));
    const identityOf = async (relativePath: string) => {
      const reached = await resolve(checkout, relativePath);
      if (!("identity" in reached)) throw new Error("not reached");
      return reached.identity;
    };

    expect(await identityOf("alias")).toBe(await identityOf("dir"));
    expect(await identityOf("dir/..")).toBe(await identityOf("."));
    expect(await identityOf("other")).not.toBe(await identityOf("dir"));
  });
});
