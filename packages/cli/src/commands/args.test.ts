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

  it("gives each of several stdin fields one line, in schema order", async () => {
    const args = await parseArguments(setPassword, ["--current-stdin", "--next-stdin"], () =>
      Promise.resolve("old\nnew\n"),
    );
    expect(args.payload).toEqual({ current: "old", next: "new" });
  });

  it("ignores the order the stdin flags were written in", async () => {
    const args = await parseArguments(setPassword, ["--next-stdin", "--current-stdin"], () =>
      Promise.resolve("old\nnew\n"),
    );
    expect(args.payload).toEqual({ current: "old", next: "new" });
  });

  it("refuses stdin with the wrong number of lines", async () => {
    await expect(
      parseArguments(setPassword, ["--current-stdin", "--next-stdin"], () =>
        Promise.resolve("only-one\n"),
      ),
    ).rejects.toThrow(/1 line\(s\) but 2 fields/);
  });

  it("has no plain flag for a password, and says why", async () => {
    await expect(
      parseArguments(setPassword, ["--current", "old", "--next-stdin"], noStdin),
    ).rejects.toThrow(/does not exist/);
  });

  it("names the stdin form when a stdin-only field is missing", async () => {
    await expect(parseArguments(setPassword, [], noStdin)).rejects.toThrow(
      /missing required --current-stdin, --next-stdin/,
    );
  });

  it("does not read stdin when no stdin flag was given", async () => {
    await expect(
      parseArguments(create, ["--name", "a", "--grants", "task.read"], noStdin),
    ).resolves.toBeDefined();
  });

  it("parses --sort into a field and an optional direction", async () => {
    // No direction means no direction: the operation's own default order stands.
    expect((await parseArguments(query, ["--sort", "name"], noStdin)).sort).toEqual({
      field: "name",
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

  it("sends null for a nullable field written as null, and text for one that is not", async () => {
    const task = commandFor("task", "update")!;
    const project = commandFor("project", "update")!;

    const detached = await parseArguments(task, ["id", "--projectId", "null"], noStdin);
    expect(detached.payload["projectId"]).toBeNull();

    const cleared = await parseArguments(project, ["id", "--description", "null"], noStdin);
    expect(cleared.payload["description"]).toBeNull();

    // A field that does not accept null keeps the word as the word.
    const titled = await parseArguments(task, ["id", "--title", "null"], noStdin);
    expect(titled.payload["title"]).toBe("null");

    const named = await parseArguments(project, ["id", "--name", "null"], noStdin);
    expect(named.payload["name"]).toBe("null");
  });

  it("still takes a plain value for a nullable field", async () => {
    const task = commandFor("task", "update")!;
    const id = "0199e0e7-0000-7000-8000-000000000001";
    const args = await parseArguments(task, ["id", "--projectId", id], noStdin);
    expect(args.payload["projectId"]).toBe(id);
  });
});
