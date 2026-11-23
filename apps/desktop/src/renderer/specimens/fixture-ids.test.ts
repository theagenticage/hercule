import { expect, it } from "vitest";
import { buildFixtureIdConverter } from "./fixture-ids";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

it("gives the same UUID to a fixture id wherever the world names it", () => {
  const world = {
    projects: [{ id: "p-webshop", mcpServerIds: ["s-github"] }],
    threads: [{ id: "s-github-thread", projectId: "p-webshop" }],
  };
  const convert = buildFixtureIdConverter(world);
  const converted = convert(world);
  expect(converted.projects[0]!.id).toMatch(UUID_V7);
  expect(converted.threads[0]!.projectId).toBe(converted.projects[0]!.id);
  expect(convert("p-webshop")).toBe(converted.projects[0]!.id);
  expect(converted.projects[0]!.mcpServerIds[0]).toMatch(UUID_V7);
});

it("leaves ids that are not fixture ids, and text that is not in an id field, as they are", () => {
  const world = {
    id: "01a0ec64-6e80-7000-8000-000000000024",
    plugin: { id: "github/github", name: "p-webshop" },
    turnId: "turn-1",
  };
  expect(buildFixtureIdConverter(world)(world)).toEqual(world);
});
