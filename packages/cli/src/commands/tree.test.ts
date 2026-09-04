import { ALL_OPERATIONS, OPERATIONS } from "@hydra/contract";
import { describe, expect, it } from "vitest";
import { COMMANDS, commandFor } from "./tree";

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
      expect(
        commandFor(command.entity, "query"),
        `${command.id} has no tail resolver`,
      ).toBeDefined();
    }
  });
});
