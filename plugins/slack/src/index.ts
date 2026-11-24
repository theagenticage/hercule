/**
 * The Slack plugin: the Slack connection type, which creates a Slack app for
 * each Connection, and the MCP server that gives sessions Slack's tools.
 */
import { Effect, Schema } from "effect";
import {
  HOST_API,
  registerConnectionType,
  registerMcpServer,
  type Plugin,
} from "@hercule/plugin-host";
import { connectionType } from "./connection-type";
import { slackMcpServer } from "./mcp-server";

/**
 * The Slack mark, path data only, on the 16x16 grid a plugin's mark uses. It
 * is Simple Icons' Slack mark (CC0), drawn on a 24-unit grid there, with
 * every coordinate scaled by 2/3 and rounded to six decimals, so it draws the
 * same pixels as the original.
 */
const SLACK_MARK_PATH =
  "M3.361333 10.11a1.685333 1.685333 0 0 1-1.68 1.682A1.685333 1.685333 0 0 1 0 10.11a1.684667 1.684667 0 0 1 1.681333-1.68h1.68v1.68zM4.208667 10.11a1.684667 1.684667 0 0 1 1.680667-1.68 1.684667 1.684667 0 0 1 1.680667 1.68v4.208667A1.685333 1.685333 0 0 1 5.889333 16a1.685333 1.685333 0 0 1-1.680667-1.681333v-4.208667zM5.889333 3.361333a1.685333 1.685333 0 0 1-1.680667-1.68A1.685333 1.685333 0 0 1 5.889333 0a1.685333 1.685333 0 0 1 1.680667 1.681333v1.68H5.889333zM5.889333 4.208667a1.685333 1.685333 0 0 1 1.680667 1.680667 1.685333 1.685333 0 0 1-1.680667 1.680667H1.681333A1.685333 1.685333 0 0 1 0 5.889333a1.685333 1.685333 0 0 1 1.681333-1.680667h4.208zM12.637333 5.889333a1.685333 1.685333 0 0 1 1.681333-1.680667A1.685333 1.685333 0 0 1 16 5.889333a1.685333 1.685333 0 0 1-1.681333 1.680667h-1.681333V5.889333zM11.792 5.889333a1.685333 1.685333 0 0 1-1.682 1.680667 1.684667 1.684667 0 0 1-1.68-1.680667V1.681333A1.684667 1.684667 0 0 1 10.11 0a1.685333 1.685333 0 0 1 1.682 1.681333v4.208zM10.11 12.637333a1.685333 1.685333 0 0 1 1.682 1.681333A1.685333 1.685333 0 0 1 10.11 16a1.684667 1.684667 0 0 1-1.68-1.681333v-1.681333h1.68zM10.11 11.792a1.684667 1.684667 0 0 1-1.68-1.682 1.684 1.684 0 0 1 1.68-1.68h4.208667A1.684667 1.684667 0 0 1 16 10.11a1.685333 1.685333 0 0 1-1.681333 1.682h-4.208667z";

export const slack: Plugin = {
  manifest: {
    id: "slack",
    displayName: "Slack",
    hostApi: HOST_API,
    capabilities: ["connections", "mcp-servers"],
    configSchema: Schema.Struct({}),
    // Slack's aubergine.
    mark: { paths: [SLACK_MARK_PATH], hue: 300 },
  },
  register: (host) =>
    Effect.gen(function* () {
      yield* registerConnectionType(host, connectionType);
      yield* registerMcpServer(host, slackMcpServer);
    }),
  activate: () => Effect.succeed(Effect.void),
};
