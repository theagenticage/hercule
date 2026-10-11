import { describe, expect, it } from "vitest";
import { UsageError } from "../exit";
import { parseArguments } from "./args";
import { findCommandByWords } from "./tree";

const lookUpCommand = (...words: ReadonlyArray<string>) => findCommandByWords(words)!;

const profileCreate = lookUpCommand("profile", "create");
const profileList = lookUpCommand("profile", "list");
const taskCreate = lookUpCommand("task", "create");
const taskList = lookUpCommand("task", "list");
const taskUpdate = lookUpCommand("task", "update");
const projectUpdate = lookUpCommand("project", "update");
const sessionInput = lookUpCommand("session", "input");
const setPassword = lookUpCommand("user", "set-password");

const refuseStdinRead = () => Promise.reject(new Error("stdin was read"));
const stubStdin = (text: string) => () => Promise.resolve(text);

const ID = "1f3a9c2e";

// Tests which fields are read from stdin, and which inline values are rejected.
describe("a required stdin field", () => {
  it("is all of stdin minus one trailing newline, without a marker", async () => {
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

  it("is read without a marker on session input too", async () => {
    const args = await parseArguments(sessionInput, [ID], stubStdin("Carry on.\n"));
    expect(args.payload["text"]).toBe("Carry on.");
    expect(args.positionals).toEqual([ID]);
  });

  it("accepts its marker even though it is not needed", async () => {
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
  it("rejects --description <value> and names the stdin form", async () => {
    await expect(
      parseArguments(taskUpdate, [ID, "--description", "inline"], refuseStdinRead),
    ).rejects.toThrow(/--description-stdin/);
    await expect(
      parseArguments(taskUpdate, [ID, "--description", "inline"], refuseStdinRead),
    ).rejects.toThrow(UsageError);
  });

  it("rejects --description-stdin=<value>", async () => {
    await expect(
      parseArguments(taskUpdate, [ID, "--description-stdin=inline"], refuseStdinRead),
    ).rejects.toThrow(UsageError);
  });

  it("rejects an inline password and says why", async () => {
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

  it("assigns the two lines in schema order, whatever order the markers are in", async () => {
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

  it("rejects stdin that is not two lines", async () => {
    await expect(parseArguments(setPassword, [], stubStdin("only-one\n"))).rejects.toThrow(
      /1 line\(s\), but 2 fields/,
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

  it("parses --sort into a list of one key, with a field and an optional direction", async () => {
    // Without a direction, none is set: the API reads a key with no direction as asc.
    expect((await parseArguments(profileList, ["--sort", "name"], refuseStdinRead)).sort).toEqual([
      { field: "name" },
    ]);
    expect(
      (await parseArguments(profileList, ["--sort", "name:desc"], refuseStdinRead)).sort,
    ).toEqual([{ field: "name", direction: "desc" }]);
  });

  it("parses each --sort into its own key, in the order written", async () => {
    const parsed = await parseArguments(
      taskList,
      ["--sort", "priority:desc", "--sort", "createdAt"],
      refuseStdinRead,
    );
    expect(parsed.sort).toEqual([{ field: "priority", direction: "desc" }, { field: "createdAt" }]);
  });

  it("rejects a value outside a field's closed set", async () => {
    await expect(
      parseArguments(profileCreate, ["--name", "a", "--grant", "task.fly"], refuseStdinRead),
    ).rejects.toThrow(UsageError);
  });

  it("rejects a short flag rather than counting it as an argument", async () => {
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

  it("sends null for a nullable field given null, and the text for a field that is not nullable", async () => {
    const detached = await parseArguments(taskUpdate, [ID, "--project", "null"], refuseStdinRead);
    expect(detached.payload["projectId"]).toBeNull();

    // A field that does not accept null gets the text "null".
    const titled = await parseArguments(taskUpdate, [ID, "--title", "null"], refuseStdinRead);
    expect(titled.payload["title"]).toBe("null");

    const named = await parseArguments(projectUpdate, [ID, "--name", "null"], refuseStdinRead);
    expect(named.payload["name"]).toBe("null");
  });

  it("still accepts a normal value for a nullable field", async () => {
    const full = "0199e0e7-0000-7000-8000-000000000001";
    const args = await parseArguments(taskUpdate, [ID, "--project", full], refuseStdinRead);
    expect(args.payload["projectId"]).toBe(full);
  });
});

// Tests `--image`, and how it changes the reading of the prompt from stdin.
describe("--image", () => {
  const sessionSpawn = lookUpCommand("session", "spawn");
  const sessionContinue = lookUpCommand("session", "continue");

  it("collects the paths in the order the flags were given", async () => {
    const args = await parseArguments(
      sessionInput,
      [ID, "--image", "b.png", "--image=a.jpg"],
      stubStdin("Look at these.\n"),
    );
    expect(args.payload).toEqual({ text: "Look at these.", attachments: ["b.png", "a.jpg"] });
  });

  it("is taken by session spawn and session continue too", async () => {
    const spawned = await parseArguments(sessionSpawn, ["--image", "a.png"], stubStdin("x"));
    expect(spawned.payload["attachments"]).toEqual(["a.png"]);
    const forked = await parseArguments(
      sessionContinue,
      [ID, "--mode", "fork", "--image", "a.png"],
      stubStdin("x"),
    );
    expect(forked.payload["attachments"]).toEqual(["a.png"]);
  });

  it("is unknown on input update, which keeps the images an input has", async () => {
    await expect(
      parseArguments(
        lookUpCommand("input", "update"),
        [ID, "0193f3a9-2e5c-7b41-9a6d-1f3a9c2e77b0", "--image", "a.png"],
        stubStdin("x"),
      ),
    ).rejects.toThrow("unknown flag --image");
  });

  it("sends empty text without reading stdin when stdin is a terminal", async () => {
    const args = await parseArguments(
      sessionInput,
      [ID, "--image", "a.png"],
      refuseStdinRead,
      true,
    );
    expect(args.payload).toEqual({ text: "", attachments: ["a.png"] });
  });

  it("still reads a pipe, and an empty pipe sends empty text", async () => {
    const args = await parseArguments(sessionInput, [ID, "--image", "a.png"], stubStdin(""));
    expect(args.payload).toEqual({ text: "", attachments: ["a.png"] });
  });

  it("leaves a terminal without --image to the reader, which refuses it", async () => {
    await expect(parseArguments(sessionInput, [ID], refuseStdinRead, true)).rejects.toThrow(
      "stdin was read",
    );
  });
});

// Tests the two signal fields that are content, and so come from stdin.
describe("signal content on stdin", () => {
  const signalRaise = lookUpCommand("signal", "raise");
  const signalAct = lookUpCommand("signal", "act");
  const raising = ["--kind", "fyi", "--title", "Shipped", "--reason", "Tagged", "--event-id", "7"];

  it("reads raise's blocks from stdin as a JSON list after --blocks-stdin", async () => {
    const args = await parseArguments(
      signalRaise,
      [...raising, "--blocks-stdin"],
      stubStdin('[{"type":"text","markdown":"Release notes"}]\n'),
    );
    expect(args.payload["blocks"]).toEqual([{ type: "text", markdown: "Release notes" }]);
    expect(args.payload["eventIds"]).toEqual([7]);
  });

  it("sends raise without blocks, and reads no stdin, when --blocks-stdin is not given", async () => {
    const args = await parseArguments(signalRaise, raising, refuseStdinRead);
    expect(args.payload).not.toHaveProperty("blocks");
  });

  it("reads act's typed reply from stdin as text after --text-stdin", async () => {
    const args = await parseArguments(
      signalAct,
      [ID, "--action", "reply", "--text-stdin"],
      stubStdin("Thanks, merging now.\n"),
    );
    expect(args.payload).toEqual({ actionId: "reply", text: "Thanks, merging now." });
  });
});
