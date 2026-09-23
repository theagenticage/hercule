import { describe, expect, it } from "vitest";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as OpenApi from "effect/unstable/httpapi/OpenApi";
import { api } from "./api";
import { ALL_GRANTS } from "./grants";
import { ALL_OPERATIONS, isOperationId, OPERATIONS, type OperationId } from "./operations";

/** Lists every endpoint in the declaration, with its id written the way the operation table writes it. */
const listDeclaredEndpoints = (): ReadonlyArray<{ id: string; method: string; path: string }> => {
  const found: Array<{ id: string; method: string; path: string }> = [];
  HttpApi.reflect(api, {
    onGroup: () => {},
    onEndpoint: ({ endpoint, group }) => {
      found.push({
        id: `${group.identifier}.${endpoint.identifier}`,
        method: endpoint.method,
        path: endpoint.path,
      });
    },
  });
  return found;
};

describe("the operation table", () => {
  it("requires only grants that exist in the vocabulary", () => {
    const markers = new Set(["unauthenticated", "setup-token", "authenticated"]);
    const grants = new Set<string>(ALL_GRANTS);
    for (const operation of ALL_OPERATIONS) {
      if (markers.has(operation.requires)) continue;
      expect(grants, `${operation.id} requires ${operation.requires}`).toContain(
        operation.requires,
      );
    }
  });

  it("routes every operation under the versioned prefix", () => {
    for (const operation of ALL_OPERATIONS) {
      expect(operation.path.startsWith("/api/v1/"), operation.id).toBe(true);
    }
  });

  it("gives no two operations the same method and path", () => {
    const seen = new Map<string, OperationId>();
    for (const operation of ALL_OPERATIONS) {
      const route = `${operation.method} ${operation.path}`;
      expect(seen.get(route), `${operation.id} collides on ${route}`).toBeUndefined();
      seen.set(route, operation.id);
    }
  });
});

describe("the HttpApi declaration", () => {
  it("has exactly one endpoint per operation, on the route the table names", () => {
    const endpoints = listDeclaredEndpoints();
    expect(endpoints.length).toBe(ALL_OPERATIONS.length);

    for (const endpoint of endpoints) {
      expect(isOperationId(endpoint.id), `${endpoint.id} is not in the operation table`).toBe(true);
      if (!isOperationId(endpoint.id)) continue;
      const row = OPERATIONS[endpoint.id];
      expect({ method: endpoint.method, path: endpoint.path }).toEqual({
        method: row.method,
        path: row.path,
      });
    }

    const ids = new Set(endpoints.map((endpoint) => endpoint.id));
    for (const operation of ALL_OPERATIONS) {
      expect(ids, `${operation.id} has no endpoint`).toContain(operation.id);
    }
  });

  it("generates an OpenAPI document", () => {
    const document = OpenApi.fromApi(api);
    expect(Object.keys(document.paths).length).toBeGreaterThan(0);
  });

  it("documents the full schema of a workflow save's definition, although the request schema accepts any JSON value there", () => {
    /** The parts of a JSON Schema this test reads. */
    interface SchemaPart {
      readonly properties?: Record<string, SchemaPart>;
      readonly required?: ReadonlyArray<string>;
    }
    const create = OpenApi.fromApi(api).paths["/api/v1/workflows"]?.post as
      { requestBody: { content: Record<string, { schema: SchemaPart }> } } | undefined;
    const definition =
      create?.requestBody.content["application/json"]?.schema.properties?.["definition"];
    expect(Object.keys(definition?.properties ?? {})).toEqual([
      "name",
      "description",
      "inputs",
      "triggers",
      "steps",
      "edges",
      "workspace",
    ]);
    expect(definition?.required).toEqual(["name", "steps"]);
  });
});

/**
 * The Task, Project, Event, Runner, Plugin, Session and Controller operations:
 * the operation table row and the endpoint that serves it.
 */
const NEW_OPERATIONS = [
  { id: "task.query", requires: "task.read", method: "GET", path: "/api/v1/tasks" },
  { id: "task.read", requires: "task.read", method: "GET", path: "/api/v1/tasks/:id" },
  { id: "task.create", requires: "task.create", method: "POST", path: "/api/v1/tasks" },
  { id: "task.update", requires: "task.update", method: "PATCH", path: "/api/v1/tasks/:id" },
  { id: "task.delete", requires: "task.delete", method: "DELETE", path: "/api/v1/tasks/:id" },
  { id: "project.query", requires: "project.read", method: "GET", path: "/api/v1/projects" },
  { id: "project.read", requires: "project.read", method: "GET", path: "/api/v1/projects/:id" },
  { id: "project.create", requires: "project.write", method: "POST", path: "/api/v1/projects" },
  {
    id: "project.update",
    requires: "project.write",
    method: "PATCH",
    path: "/api/v1/projects/:id",
  },
  {
    id: "project.delete",
    requires: "project.write",
    method: "DELETE",
    path: "/api/v1/projects/:id",
  },
  { id: "event.query", requires: "event.read", method: "GET", path: "/api/v1/events" },
  { id: "event.read", requires: "event.read", method: "GET", path: "/api/v1/events/:id" },
  { id: "runner.query", requires: "infra.read", method: "GET", path: "/api/v1/runners" },
  { id: "runner.read", requires: "infra.read", method: "GET", path: "/api/v1/runners/:id" },
  { id: "runner.update", requires: "infra.write", method: "PATCH", path: "/api/v1/runners/:id" },
  {
    id: "runner.drain",
    requires: "infra.write",
    method: "POST",
    path: "/api/v1/runners/:id/drain",
  },
  {
    id: "runner.undrain",
    requires: "infra.write",
    method: "POST",
    path: "/api/v1/runners/:id/undrain",
  },
  {
    id: "runner.retire",
    requires: "infra.write",
    method: "POST",
    path: "/api/v1/runners/:id/retire",
  },
  { id: "plugin.query", requires: "infra.read", method: "GET", path: "/api/v1/plugins" },
  { id: "plugin.read", requires: "infra.read", method: "GET", path: "/api/v1/plugins/:id" },
  {
    id: "plugin.enable",
    requires: "infra.write",
    method: "POST",
    path: "/api/v1/plugins/:id/enable",
  },
  {
    id: "plugin.disable",
    requires: "infra.write",
    method: "POST",
    path: "/api/v1/plugins/:id/disable",
  },
  {
    id: "plugin.retry",
    requires: "infra.write",
    method: "POST",
    path: "/api/v1/plugins/:id/retry",
  },
  {
    id: "plugin.resetState",
    requires: "infra.write",
    method: "POST",
    path: "/api/v1/plugins/:id/reset-state",
  },
  {
    id: "plugin.configure",
    requires: "infra.write",
    method: "PUT",
    path: "/api/v1/plugins/:id/config",
  },
  {
    id: "session.respond",
    requires: "session.steer",
    method: "POST",
    path: "/api/v1/sessions/:id/respond",
  },
  {
    id: "controller.update",
    requires: "infra.write",
    method: "PATCH",
    path: "/api/v1/controller",
  },
] as const;

/** The table read by string, so a missing row is a failed assertion, not a type error. */
const table: Record<string, { requires: string; method: string; path: string } | undefined> =
  OPERATIONS;

describe("the operations with an explicit row", () => {
  it.each(NEW_OPERATIONS)("puts $id in the operation table on $method $path", (operation) => {
    expect(table[operation.id]).toEqual({
      requires: operation.requires,
      method: operation.method,
      path: operation.path,
    });
  });

  it.each(NEW_OPERATIONS)("serves $id from exactly one endpoint on $method $path", (operation) => {
    const endpoints = listDeclaredEndpoints().filter((endpoint) => endpoint.id === operation.id);
    expect(endpoints).toEqual([
      { id: operation.id, method: operation.method, path: operation.path },
    ]);
  });
});
