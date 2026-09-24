import { describe, expect, it } from "vitest";
import { UsageError } from "../exit";
import { parseArguments } from "./args";
import { findCommandByWords } from "./tree";

const lookUpCommand = (...words: ReadonlyArray<string>) => findCommandByWords(words)!;

const profileCreate = lookUpCommand("profile", "create");
const profileList = lookUpCommand("profile", "list");
const taskCreate = lookUpCommand("task", "create");
const taskUpdate = lookUpCommand("task", "update");
const projectUpdate = lookUpCommand("project", "update");
const sessionInput = lookUpCommand("session", "input");
const setPassword = lookUpCommand("user", "set-password");

const refuseStdinRead = () => Promise.reject(new Error("stdin was read"));
const stubStdin = (text: string) => () => Promise.resolve(text);

const ID = "1f3a9c2e";

// what comes from stdin, and what refuses to.
describe("a required stdin field", () => {
  it("is the whole of stdin less one trailing newline, with no marker given", async () => {
    const args = await parseArguments(
      taskCreate,
      ["--title", "Fix the flaky login test"],
      stubStdin("It fails one run in five.\n"),
    );
    expect(args.payload["description"]).toBe("It fails one run in five.");
  });

  it("keeps the newlines inside a document", async () => {
    const args = await parseArguments(taskCreate, ["--title", "x"], stubStdin("one\n\ntwo\n"));
    expect(args.payload["description"]).toBe("one\n\ntwo");
  });

  it("strips a trailing CRLF, as saved on Windows, like a trailing newline", async () => {
    const args = await parseArguments(taskCreate, ["--title", "x"], stubStdin("one\r\ntwo\r\n"));
    expect(args.payload["description"]).toBe("one\r\ntwo");
  });

  it("is read unasked on session input too", async () => {
    const args = await parseArguments(sessionInput, [ID], stubStdin("Carry on.\n"));
    expect(args.payload["text"]).toBe("Carry on.");
    expect(args.positionals).toEqual([ID]);
  });

  it("accepts its marker redundantly", async () => {
    const args = await parseArguments(sessionInput, [ID, "--text-stdin"], stubStdin("Carry on.\n"));
    expect(args.payload["text"]).toBe("Carry on.");
  });
});

describe("an optional stdin field", () => {
  it("is absent when its marker is not given, and stdin is never read", async () => {
    const args = await parseArguments(taskUpdate, [ID, "--status", "in-progress"], refuseStdinRead);
    expect("description" in args.payload).toBe(false);
    expect(args.payload).toEqual({ status: "in-progress" });
  });

  it("is read only when its marker is given", async () => {
    const args = await parseArguments(
      taskUpdate,
      [ID, "--description-stdin"],
      stubStdin("Reproduced: the redirect races the session cookie.\n"),
    );
    expect(args.payload["description"]).toBe("Reproduced: the redirect races the session cookie.");
  });
});

describe("a stdin field given inline", () => {
  it("refuses --description <value> and names the stdin form", async () => {
    await expect(
      parseArguments(taskUpdate, [ID, "--description", "inline"], refuseStdinRead),
    ).rejects.toThrow(/--description-stdin/);
    await expect(
      parseArguments(taskUpdate, [ID, "--description", "inline"], refuseStdinRead),
    ).rejects.toThrow(UsageError);
  });

  it("refuses --description-stdin=<value>", async () => {
    await expect(
      parseArguments(taskUpdate, [ID, "--description-stdin=inline"], refuseStdinRead),
    ).rejects.toThrow(UsageError);
  });

  it("refuses an inline password and says why", async () => {
    await expect(
      parseArguments(setPassword, ["--current", "old"], refuseStdinRead),
    ).rejects.toThrow(/--current-stdin/);
  });
});

describe("user set-password", () => {
  it("reads the current password then the next one, with no marker given", async () => {
    const args = await parseArguments(setPassword, [], stubStdin("old\nnew\n"));
    expect(args.payload).toEqual({ current: "old", next: "new" });
  });

  it("reads the same two lines whatever order the markers are written in", async () => {
    const args = await parseArguments(
      setPassword,
      ["--next-stdin", "--current-stdin"],
      stubStdin("old\nnew\n"),
    );
    expect(args.payload).toEqual({ current: "old", next: "new" });
  });

  it("splits lines at CRLF, so neither password keeps a carriage return", async () => {
    const args = await parseArguments(setPassword, [], stubStdin("old\r\nnew\r\n"));
    expect(args.payload).toEqual({ current: "old", next: "new" });
  });

  it("refuses stdin that is not two lines", async () => {
    await expect(parseArguments(setPassword, [], stubStdin("only-one\n"))).rejects.toThrow(
      /1 line\(s\) but 2 fields/,
    );
  });
});

describe("parseArguments", () => {
  it("accepts --flag value and --flag=value alike", async () => {
    const spaced = await parseArguments(
      profileCreate,
      ["--name", "a", "--grant", "task.read"],
      refuseStdinRead,
    );
    const joined = await parseArguments(
      profileCreate,
      ["--name=a", "--grant=task.read"],
      refuseStdinRead,
    );
    expect(spaced.payload).toEqual(joined.payload);
  });

  it("does not read stdin for a command that takes nothing from it", async () => {
    await expect(
      parseArguments(profileCreate, ["--name", "a", "--grant", "task.read"], refuseStdinRead),
    ).resolves.toBeDefined();
  });

  it("parses --sort into a field and an optional direction", async () => {
    // No direction means no direction: the operation's own default order stands.
    expect((await parseArguments(profileList, ["--sort", "name"], refuseStdinRead)).sort).toEqual({
      field: "name",
    });
    expect(
      (await parseArguments(profileList, ["--sort", "name:desc"], refuseStdinRead)).sort,
    ).toEqual({
      field: "name",
      direction: "desc",
    });
  });

  it("rejects a value outside a field's closed set", async () => {
    await expect(
      parseArguments(profileCreate, ["--name", "a", "--grant", "task.fly"], refuseStdinRead),
    ).rejects.toThrow(UsageError);
  });

  it("refuses a short flag rather than counting it as an argument", async () => {
    await expect(parseArguments(profileList, ["-x"], refuseStdinRead)).rejects.toThrow(
      /unknown flag -x/,
    );
    await expect(parseArguments(profileList, ["-x"], refuseStdinRead)).rejects.toThrow(UsageError);
  });

  it("rejects the wrong number of positional arguments", async () => {
    await expect(parseArguments(profileList, ["extra"], refuseStdinRead)).rejects.toThrow(
      /takes 0 argument/,
    );
  });

  it("sends null for a nullable field written as null, and text for one that is not", async () => {
    const detached = await parseArguments(taskUpdate, [ID, "--project", "null"], refuseStdinRead);
    expect(detached.payload["projectId"]).toBeNull();

    // A field that does not accept null keeps the word as the word.
    const titled = await parseArguments(taskUpdate, [ID, "--title", "null"], refuseStdinRead);
    expect(titled.payload["title"]).toBe("null");

    const named = await parseArguments(projectUpdate, [ID, "--name", "null"], refuseStdinRead);
    expect(named.payload["name"]).toBe("null");
  });

  it("still takes a plain value for a nullable field", async () => {
    const full = "0199e0e7-0000-7000-8000-000000000001";
    const args = await parseArguments(taskUpdate, [ID, "--project", full], refuseStdinRead);
    expect(args.payload["projectId"]).toBe(full);
  });
});
