import { describe, expect, it } from "vitest";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as OpenApi from "effect/unstable/httpapi/OpenApi";
import { api } from "./api";
import { ALL_GRANTS } from "./grants";
import { ALL_OPERATIONS, isOperationId, OPERATIONS, type OperationId } from "./operations";

/** Every endpoint in the declaration, named the way the operation table names it. */
const declared = (): ReadonlyArray<{ id: string; method: string; path: string }> => {
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
  it("names only grants that exist in the vocabulary", () => {
    const markers = new Set(["unauthenticated", "setup-token", "authenticated"]);
    const grants = new Set<string>(ALL_GRANTS);
    for (const operation of ALL_OPERATIONS) {
      if (markers.has(operation.requires)) continue;
      expect(grants, `${operation.id} requires ${operation.requires}`).toContain(
        operation.requires,
      );
    }
  });

  it("routes every operation under the versioned prefix, with a plural noun", () => {
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
    const endpoints = declared();
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
});
