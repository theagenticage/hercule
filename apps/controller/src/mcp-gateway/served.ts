/**
 * What one session is served (spec 21 section 3.3): the tools of the servers
 * in its list that may be served, under the gateway's names, with the one-line
 * instructions. `tools/list`, the instructions and `list_changed` all read the
 * same projection, so they can never disagree.
 */
import { createHash } from "node:crypto";
import type { ServedMcpServer, StoredMcpTool } from "../mcp-servers";
import { buildInstructions } from "./instructions";
import { allocateToolNames, type ToolKey } from "./tool-names";

/** One tool the session is served, under the name the gateway gives it. */
export interface ServedTool {
  /** The name the gateway sends: `<server name>__<tool>`, shortened if needed. */
  readonly name: string;
  readonly serverId: string;
  readonly serverName: string;
  /** The tool's name as the server lists it. */
  readonly tool: string;
  readonly definition: StoredMcpTool;
}

/** What a session is served right now. */
export interface ServedProjection {
  /** The tools, in the order the names were given. */
  readonly tools: ReadonlyArray<ServedTool>;
  readonly instructions: string;
  /** Changes whenever a tool, a tool's definition or the instructions change. */
  readonly fingerprint: string;
  /** Tools that got no unique name and are not served. */
  readonly leftOut: ReadonlyArray<ToolKey>;
  /** The ids of the servers the session is served, whether or not they have a tool. */
  readonly servedServerIds: ReadonlySet<string>;
}

/**
 * What a name the gateway sent stands for: the tool, and the id of the server
 * the list held then. A call is dispatched to the server the list holds by
 * name when the call arrives. The id only lets a refusal name the server a
 * call meant after the list dropped it.
 */
export interface ReservedTool extends ToolKey {
  readonly serverId: string;
}

/** The meaning of every name the gateway has sent to one Session Token, by name. */
export type NameReservations = ReadonlyMap<string, ReservedTool>;

/** What a projection is built from. */
export interface ProjectionInput {
  /** The session's own list of servers, as the records the catalogue holds for it. */
  readonly records: ReadonlyArray<ServedMcpServer>;
  /** Whether the session's profile holds `mcp.use`. Without it nothing is served. */
  readonly holdsMcpUse: boolean;
  readonly reservations: NameReservations;
}

/**
 * Returns whether the server is served: it is in the list the caller read, it
 * may be served now, and its tool list is stored. A server that is not `ready`
 * is still served, and a call to it is refused with the reason.
 */
export const isServed = ({ server, servable }: ServedMcpServer): boolean =>
  servable && server.enabled && server.checkedAt !== null;

/**
 * Builds the projection of one session. A session whose profile lacks
 * `mcp.use` is served nothing, and the instructions say why. Pure: it reads
 * nothing, and the caller commits the names of `tools` to its reservations
 * once it has sent them.
 */
export const buildProjection = ({
  records,
  holdsMcpUse,
  reservations,
}: ProjectionInput): ServedProjection => {
  const served = holdsMcpUse ? records.filter(isServed) : [];
  const allocated = allocateToolNames(
    served.map(({ server }) => ({
      serverName: server.name,
      tools: server.tools.map((tool) => tool.name),
    })),
    reservations,
  );
  const tools = allocated.named.map(({ name, serverName, tool }): ServedTool => {
    const { server } = served.find((one) => one.server.name === serverName)!;
    return {
      name,
      serverId: server.id,
      serverName,
      tool,
      definition: server.tools.find((one) => one.name === tool)!,
    };
  });
  const instructions = buildInstructions(
    served.map(({ server }) => server.name).toSorted(),
    holdsMcpUse ? undefined : "missing-grant",
  );
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ instructions, tools: tools.map((one) => [one.name, one.definition]) }))
    .digest("hex");
  return {
    tools,
    instructions,
    fingerprint,
    leftOut: allocated.leftOut,
    servedServerIds: new Set(served.map(({ server }) => server.id)),
  };
};

/** Returns `reservations` with the names of `tools` added, once the gateway has sent them. */
export const reserveServedTools = (
  reservations: NameReservations,
  tools: ReadonlyArray<ServedTool>,
): NameReservations => {
  const next = new Map(reservations);
  for (const { name, serverName, tool, serverId } of tools) {
    next.set(name, { serverName, tool, serverId });
  }
  return next;
};

/**
 * Returns a tool as `tools/list` sends it: the stored definition under the
 * gateway's name.
 */
export const buildToolDefinition = ({ name, definition }: ServedTool): Record<string, unknown> => ({
  name,
  ...(definition.title === undefined ? {} : { title: definition.title }),
  description: definition.description,
  inputSchema: definition.inputSchema,
  ...(definition.outputSchema === undefined ? {} : { outputSchema: definition.outputSchema }),
  ...(definition.annotations === undefined ? {} : { annotations: definition.annotations }),
});
