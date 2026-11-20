/**
 * The rule every list of MCP Servers follows, and the grant every write of
 * one needs (spec 21 section 4.1 and 4.2).
 *
 * A Project, a session and the thread default each hold a list of servers.
 * Each of them is written by its own service, so the rule lives here, once,
 * and the writers call it. It is not a service of its own with operations:
 * it holds no grant of its own for a read, and it must run inside the
 * writer's transaction. That is what keeps a server that is deleted at the
 * same moment from slipping into a list.
 */
import * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";
import {
  createValidationError,
  type Forbidden,
  type Validation,
  type Issue,
} from "@hercule/contract";
import { CurrentActor, checkActorHoldsGrant } from "../actor";
import { mcpServerRepository } from "./repository";

const MANAGE_REFUSAL =
  "changing the list of MCP servers needs the mcp.manage grant, which only the user gives. Ask the user to change the list, or to approve a Permission Request for mcp.manage";

/**
 * Checks that the caller holds `mcp.manage`, and fails with `Forbidden`
 * otherwise. A writer of a list calls it after its own grant check, and only
 * when the call gives a list.
 */
export const requireMcpManage: Effect.Effect<void, Forbidden> = Effect.flatMap(
  CurrentActor,
  (actor) => {
    const refused = checkActorHoldsGrant("mcp.manage", actor, MANAGE_REFUSAL);
    return refused === undefined ? Effect.void : Effect.fail(refused);
  },
);

const make = Effect.gen(function* () {
  const servers = yield* mcpServerRepository;

  return {
    /**
     * Checks a list of MCP Server ids. Fails with `Validation` when an id:
     *
     * - names no server, because it never existed or was deleted;
     * - is given twice;
     * - names a server whose name another server of the list has. The message
     *   names both servers.
     *
     * The error lists every such entry, each at its index under `path`, the
     * field the caller read the list from. Call it inside the transaction that
     * writes the list.
     */
    checkList: (
      ids: ReadonlyArray<string>,
      path: ReadonlyArray<string>,
    ): Effect.Effect<void, Validation | SqlError> =>
      Effect.gen(function* () {
        const names = yield* servers.readNames(ids);
        const issues: Array<Issue> = [];
        const idOfName = new Map<string, string>();
        const seen = new Set<string>();
        ids.forEach((id, index) => {
          const at = [...path, String(index)];
          const name = names.get(id);
          if (name === undefined) {
            issues.push({
              path: at,
              message: `no MCP server has the id ${id}; list them with \`hercule mcp-server list\``,
            });
            return;
          }
          if (seen.has(id)) {
            issues.push({ path: at, message: `the MCP server ${name} (${id}) is listed twice` });
            return;
          }
          const sameName = idOfName.get(name);
          if (sameName !== undefined) {
            issues.push({
              path: at,
              message: `two MCP servers in the list are named ${name}: ${sameName} and ${id}. A list holds one server of each name`,
            });
            return;
          }
          idOfName.set(name, id);
          seen.add(id);
        });
        if (issues.length > 0) return yield* Effect.fail(createValidationError(issues));
      }),

    /**
     * Returns the ids that name a server that exists, in the given order. It
     * drops an id whose server was deleted and checks nothing else. A reader
     * of the thread default uses it, because the default is never rewritten
     * when a server is deleted.
     */
    keepExisting: (ids: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.map(servers.readNames(ids), (names) => ids.filter((id) => names.has(id))),
  };
});

/**
 * Builds the list rule on the database client. A writer builds it once, when
 * its service is built.
 */
export const mcpServerListRule = make;
