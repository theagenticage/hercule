/**
 * Whether a thread's transcript holds a line about MCP servers. It reads no
 * server and imports no MCP model, so the first screen can use it.
 */
import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { TranscriptRow } from "@hercule/contract";
import { transcriptQuery } from "./queries";

const holdsMcpServerLine = (rows: readonly TranscriptRow[]): boolean =>
  rows.some((row) => row.event._tag === "runtime.warning" && row.event.mcpServers !== undefined);

/**
 * Checks whether a transcript holds a runtime warning about MCP servers, the
 * line that carries the buttons. Such a thread reads the servers when it
 * opens, even with an empty list, because the line names servers.
 */
export function useHasMcpServerLine(sessionId: string): boolean {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  return (
    useQuery({ ...transcriptQuery(client, sessionId), select: holdsMcpServerLine }).data === true
  );
}
