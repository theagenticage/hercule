import { describe, expect, it } from "vitest";
import { UsageError } from "../exit";
import { parseArguments } from "./args";
import { commandAt } from "./tree";

const at = (...words: ReadonlyArray<string>) => commandAt(words)!;

const profileCreate = at("profile", "create");
const profileList = at("profile", "list");
const taskCreate = at("task", "create");
const taskUpdate = at("task", "update");
const projectUpdate = at("project", "update");
const sessionInput = at("session", "input");
const setPassword = at("user", "set-password");

const noStdin = () => Promise.reject(new Error("stdin was read"));
const piped = (text: string) => () => Promise.resolve(text);

const ID = "1f3a9c2e";

// what comes from stdin, and what refuses to.
describe("a required stdin field", () => {
  it("is the whole of stdin less one trailing newline, with no marker given", async () => {
    const args = await parseArguments(
      taskCreate,
      ["--title", "Fix the flaky login test"],
      piped("It fails one run in five.\n"),
    );
    expect(args.payload["description"]).toBe("It fails one run in five.");
  });

  it("keeps the newlines inside a document", async () => {
    const args = await parseArguments(taskCreate, ["--title", "x"], piped("one\n\ntwo\n"));
    expect(args.payload["description"]).toBe("one\n\ntwo");
  });

  it("takes a final CRLF, as a file saved on Windows ends, as the one trailing newline", async () => {
    const args = await parseArguments(taskCreate, ["--title", "x"], piped("one\r\ntwo\r\n"));
    expect(args.payload["description"]).toBe("one\r\ntwo");
  });

  it("is read unasked on session input too", async () => {
    const args = await parseArguments(sessionInput, [ID], piped("Carry on.\n"));
    expect(args.payload["text"]).toBe("Carry on.");
    expect(args.positionals).toEqual([ID]);
  });

  it("accepts its marker redundantly", async () => {
    const args = await parseArguments(sessionInput, [ID, "--text-stdin"], piped("Carry on.\n"));
    expect(args.payload["text"]).toBe("Carry on.");
  });
});

describe("an optional stdin field", () => {
  it("is absent when its marker is not given, and stdin is never read", async () => {
    const args = await parseArguments(taskUpdate, [ID, "--status", "in-progress"], noStdin);
    expect("description" in args.payload).toBe(false);
    expect(args.payload).toEqual({ status: "in-progress" });
  });

  it("is read only when its marker is given", async () => {
    const args = await parseArguments(
      taskUpdate,
      [ID, "--description-stdin"],
      piped("Reproduced: the redirect races the session cookie.\n"),
    );
    expect(args.payload["description"]).toBe("Reproduced: the redirect races the session cookie.");
  });
});

describe("a stdin field given inline", () => {
  it("refuses --description <value> and names the stdin form", async () => {
    await expect(
      parseArguments(taskUpdate, [ID, "--description", "inline"], noStdin),
    ).rejects.toThrow(/--description-stdin/);
    await expect(
      parseArguments(taskUpdate, [ID, "--description", "inline"], noStdin),
    ).rejects.toThrow(UsageError);
  });

  it("refuses --description-stdin=<value>", async () => {
    await expect(
      parseArguments(taskUpdate, [ID, "--description-stdin=inline"], noStdin),
    ).rejects.toThrow(UsageError);
  });

  it("refuses an inline password and says why", async () => {
    await expect(parseArguments(setPassword, ["--current", "old"], noStdin)).rejects.toThrow(
      /--current-stdin/,
    );
  });
});

describe("user set-password", () => {
  it("reads the current password then the next one, with no marker given", async () => {
    const args = await parseArguments(setPassword, [], piped("old\nnew\n"));
    expect(args.payload).toEqual({ current: "old", next: "new" });
  });

  it("reads the same two lines whatever order the markers are written in", async () => {
    const args = await parseArguments(
      setPassword,
      ["--next-stdin", "--current-stdin"],
      piped("old\nnew\n"),
    );
    expect(args.payload).toEqual({ current: "old", next: "new" });
  });

  it("ends both lines at a CRLF, so neither password keeps a carriage return", async () => {
    const args = await parseArguments(setPassword, [], piped("old\r\nnew\r\n"));
    expect(args.payload).toEqual({ current: "old", next: "new" });
  });

  it("refuses stdin that is not two lines", async () => {
    await expect(parseArguments(setPassword, [], piped("only-one\n"))).rejects.toThrow(
      /1 line\(s\) but 2 fields/,
    );
  });
});

describe("parseArguments", () => {
  it("accepts --flag value and --flag=value alike", async () => {
    const spaced = await parseArguments(
      profileCreate,
      ["--name", "a", "--grant", "task.read"],
      noStdin,
    );
    const joined = await parseArguments(profileCreate, ["--name=a", "--grant=task.read"], noStdin);
    expect(spaced.payload).toEqual(joined.payload);
  });

  it("does not read stdin for a command that takes nothing from it", async () => {
    await expect(
      parseArguments(profileCreate, ["--name", "a", "--grant", "task.read"], noStdin),
    ).resolves.toBeDefined();
  });

  it("parses --sort into a field and an optional direction", async () => {
    // No direction means no direction: the operation's own default order stands.
    expect((await parseArguments(profileList, ["--sort", "name"], noStdin)).sort).toEqual({
      field: "name",
    });
    expect((await parseArguments(profileList, ["--sort", "name:desc"], noStdin)).sort).toEqual({
      field: "name",
      direction: "desc",
    });
  });

  it("rejects a value outside a field's closed set", async () => {
    await expect(
      parseArguments(profileCreate, ["--name", "a", "--grant", "task.fly"], noStdin),
    ).rejects.toThrow(UsageError);
  });

  it("refuses a short flag rather than counting it as an argument", async () => {
    await expect(parseArguments(profileList, ["-x"], noStdin)).rejects.toThrow(/unknown flag -x/);
    await expect(parseArguments(profileList, ["-x"], noStdin)).rejects.toThrow(UsageError);
  });

  it("rejects the wrong number of positional arguments", async () => {
    await expect(parseArguments(profileList, ["extra"], noStdin)).rejects.toThrow(
      /takes 0 argument/,
    );
  });

  it("sends null for a nullable field written as null, and text for one that is not", async () => {
    const detached = await parseArguments(taskUpdate, [ID, "--project", "null"], noStdin);
    expect(detached.payload["projectId"]).toBeNull();

    // A field that does not accept null keeps the word as the word.
    const titled = await parseArguments(taskUpdate, [ID, "--title", "null"], noStdin);
    expect(titled.payload["title"]).toBe("null");

    const named = await parseArguments(projectUpdate, [ID, "--name", "null"], noStdin);
    expect(named.payload["name"]).toBe("null");
  });

  it("still takes a plain value for a nullable field", async () => {
    const full = "0199e0e7-0000-7000-8000-000000000001";
    const args = await parseArguments(taskUpdate, [ID, "--project", full], noStdin);
    expect(args.payload["projectId"]).toBe(full);
  });
});
