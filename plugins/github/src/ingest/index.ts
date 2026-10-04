/**
 * Opens the ingest handle for one GitHub Connection. A placeholder until the
 * feeds are built: it refuses to open, so no Connection is polled.
 */
import { Effect } from "effect";
import { PluginError, type EventSourceContribution } from "@hercule/plugin-host";

export const openGithubIngest: EventSourceContribution["open"] = () =>
  Effect.fail(new PluginError({ message: "GitHub ingest is not built yet." }));
