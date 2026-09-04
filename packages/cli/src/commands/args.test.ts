import { describe, expect, it } from "vitest";
import { UsageError } from "../exit";
import { parseArguments } from "./args";
import { commandFor } from "./tree";

const create = commandFor("profile", "create")!;
const setPassword = commandFor("user", "setPassword")!;
const query = commandFor("profile", "query")!;
const noStdin = () => Promise.reject(new Error("stdin was read"));

describe("parseArguments", () => {
  it("accepts --flag value and --flag=value alike", async () => {
    const spaced = await parseArguments(create, ["--name", "a", "--grants", "task.read"], noStdin);
    const joined = await parseArguments(create, ["--name=a", "--grants=task.read"], noStdin);
    expect(spaced.payload).toEqual(joined.payload);
  });

  it("reads one stdin field as the whole of stdin, less one trailing newline", async () => {
    const args = await parseArguments(create, ["--name-stdin", "--grants", "task.read"], () =>
      Promise.resolve("a name\n"),
    );
    expect(args.payload["name"]).toBe("a name");
  });

  it("gives each of several stdin fields one line, in the order written", async () => {
    const args = await parseArguments(setPassword, ["--current-stdin", "--next-stdin"], () =>
      Promise.resolve("old\nnew\n"),
    );
    expect(args.payload).toEqual({ current: "old", next: "new" });
  });

  it("does not read stdin when no stdin flag was given", async () => {
    await expect(
      parseArguments(create, ["--name", "a", "--grants", "task.read"], noStdin),
    ).resolves.toBeDefined();
  });

  it("parses --sort into a field and a direction, defaulting to asc", async () => {
    expect((await parseArguments(query, ["--sort", "name"], noStdin)).sort).toEqual({
      field: "name",
      direction: "asc",
    });
    expect((await parseArguments(query, ["--sort", "name:desc"], noStdin)).sort).toEqual({
      field: "name",
      direction: "desc",
    });
  });

  it("rejects a value outside a field's closed set", async () => {
    await expect(
      parseArguments(create, ["--name", "a", "--grants", "task.fly"], noStdin),
    ).rejects.toThrow(UsageError);
  });

  it("rejects the wrong number of positional arguments", async () => {
    await expect(parseArguments(query, ["extra"], noStdin)).rejects.toThrow(/takes 0 argument/);
  });
});
