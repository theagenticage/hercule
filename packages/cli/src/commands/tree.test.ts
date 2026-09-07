import { ALL_OPERATIONS, OPERATIONS } from "@hydra/contract";
import { describe, expect, it } from "vitest";
import { idQueryOf } from "./execute";
import { COMMANDS, ENTITIES, commandFor } from "./tree";

describe("the command tree", () => {
  it("is exactly the operation table, spelled the same way", () => {
    expect(new Set(COMMANDS.map((command) => `${command.entity} ${command.verb}`))).toEqual(
      new Set(ALL_OPERATIONS.map((operation) => operation.id.replace(".", " "))),
    );
  });

  it("carries each operation's grant and route unchanged", () => {
    for (const command of COMMANDS) {
      expect({ requires: command.requires, method: command.method, path: command.path }).toEqual(
        OPERATIONS[command.id],
      );
    }
  });

  it("makes path parameters positional, in route order", () => {
    expect(commandFor("secret", "set")?.positionals.map((field) => field.name)).toEqual([
      "ownerKind",
      "ownerId",
      "name",
    ]);
    expect(commandFor("profile", "read")?.positionals.map((field) => field.name)).toEqual(["id"]);
    expect(commandFor("controller", "read")?.positionals).toEqual([]);
  });

  it("reads a field's kind, its optionality and its closed value set", () => {
    const create = commandFor("profile", "create")!;
    expect(create.payload.find((field) => field.name === "name")).toMatchObject({
      kind: "string",
      repeated: false,
      optional: false,
    });
    const grants = create.payload.find((field) => field.name === "grants")!;
    expect(grants.repeated).toBe(true);
    expect(grants.choices).toContain("permission.write");

    const update = commandFor("profile", "update")!;
    expect(update.payload.every((field) => field.optional)).toBe(true);

    const set = commandFor("secret", "set")!;
    expect(set.positionals[0]?.choices).toEqual([
      "connection",
      "plugin",
      "runner",
      "core",
      "provider-instance",
    ]);
  });

  it("marks the query operations as paged, with their own sort fields", () => {
    expect(commandFor("profile", "query")).toMatchObject({ paged: true, sortFields: ["name"] });
    expect(commandFor("apiKey", "query")).toMatchObject({ paged: true, sortFields: ["createdAt"] });
    expect(commandFor("profile", "read")?.paged).toBe(false);
  });

  it("keeps a query operation's filters as flags and its paging out of them", () => {
    expect(commandFor("secret", "query")?.query.map((field) => field.name)).toEqual([
      "ownerKind",
      "ownerId",
    ]);
  });

  it("has a query operation for every entity that takes an id argument", () => {
    for (const command of COMMANDS) {
      if (!command.positionals.some((field) => field.name === "id")) continue;
      const query = idQueryOf(command);
      expect(query, `${command.id} has no tail resolver`).toBeDefined();
      // A listing whose own route carries the id cannot be paged to resolve it.
      expect(
        query!.positionals,
        `${command.id} resolves its tail through a listing that needs it`,
      ).toEqual([]);
    }
  });

  it("carries the steering and queued-input operations, with their grants", () => {
    expect(commandFor("session", "input")?.requires).toBe("session.steer");
    expect(commandFor("session", "interrupt")?.requires).toBe("session.steer");
    expect(commandFor("session", "stop")?.requires).toBe("session.steer");
    expect(commandFor("session", "continue")?.requires).toBe("session.spawn");
    expect(commandFor("input", "query")?.requires).toBe("session.read");
    expect(commandFor("input", "update")?.requires).toBe("session.steer");
    expect(commandFor("input", "cancel")?.requires).toBe("session.steer");
    expect(ENTITIES).toContain("input");
  });

  it("takes an input's own route as the session id then the input id", () => {
    const names = (verb: string) =>
      commandFor("input", verb)?.positionals.map((field) => field.name);

    expect(names("query")).toEqual(["id"]);
    expect(names("update")).toEqual(["id", "inputId"]);
    expect(names("cancel")).toEqual(["id", "inputId"]);
    expect(idQueryOf(commandFor("input", "update")!)?.id).toBe("session.query");
  });

  it("has a --text flag exactly where the payload carries one", () => {
    const payloadNames = (entity: string, verb: string) =>
      commandFor(entity, verb)?.payload.map((field) => field.name);

    expect(payloadNames("session", "input")).toContain("text");
    expect(payloadNames("input", "update")).toContain("text");

    expect(payloadNames("session", "interrupt")).toEqual([]);
    expect(payloadNames("session", "stop")).toEqual([]);
    expect(payloadNames("session", "continue")).not.toContain("text");
    expect(payloadNames("input", "query")).toEqual([]);
    expect(payloadNames("input", "cancel")).toEqual([]);
  });
});
