/**
 * Tools a server lists that the gateway does not offer (spec 21 section 3.4):
 * the words the Thread gets, and how often it is told. Everything here is
 * pure except the map `claimLeftOutWarnings` records into.
 */
import type { ToolKey } from "./tool-names";

/** One server with tools that are not offered, and how many. */
export interface LeftOutServer {
  readonly serverName: string;
  readonly count: number;
}

/**
 * Returns the line the Thread shows for the tools of a server that are not
 * offered. It names the server and the number, never a tool, because tool
 * names come from outside servers.
 */
export const buildLeftOutToolsWarning = ({ serverName, count }: LeftOutServer): string =>
  `The MCP server "${serverName}" lists ${count === 1 ? "1 tool" : `${count} tools`} that ` +
  `${count === 1 ? "is" : "are"} not offered to this Thread, because ` +
  `${count === 1 ? "its name is" : "their names are"} not valid text or another tool of the server ` +
  `would get the same name here. The server's other tools work. ` +
  `Rename ${count === 1 ? "that tool" : "those tools"} on the server to offer ${count === 1 ? "it" : "them"}.`;

/**
 * Decides which servers the Thread is told about, and records it. `told` holds
 * for each server name the tools it was last told were not offered. A server
 * is returned when it has tools left out and its set differs from the one in
 * `told`, so the Thread hears of a set once until it changes. A server with
 * nothing left out is forgotten, so a later set is told again. The servers are
 * returned in order by name.
 */
export const claimLeftOutWarnings = (
  told: Map<string, string>,
  leftOut: ReadonlyArray<ToolKey>,
): ReadonlyArray<LeftOutServer> => {
  const byServer = new Map<string, Array<string>>();
  for (const { serverName, tool } of leftOut) {
    byServer.set(serverName, [...(byServer.get(serverName) ?? []), tool]);
  }
  for (const serverName of told.keys()) {
    if (!byServer.has(serverName)) told.delete(serverName);
  }
  const claimed: Array<LeftOutServer> = [];
  for (const [serverName, tools] of byServer) {
    const set = JSON.stringify(tools.toSorted());
    if (told.get(serverName) === set) continue;
    told.set(serverName, set);
    claimed.push({ serverName, count: tools.length });
  }
  return claimed.toSorted((one, other) =>
    one.serverName < other.serverName ? -1 : one.serverName > other.serverName ? 1 : 0,
  );
};
