/**
 * What a plugin is told when something it registered is refused.
 *
 * Every refusal a plugin author reads is built here, so the published maximum
 * length holds for all of them and one bad field reads the same wherever it was
 * declared. A leaf: it knows the message shapes and nothing about the host or
 * the catalog.
 */
import type * as Schema from "effect/Schema";
import { PluginError } from "@hercule/plugin-host";
import {
  truncateText,
  formatIssue,
  listDecodeIssues,
  MAX_PLUGIN_MESSAGE_LENGTH,
} from "@hercule/contract";

/**
 * Truncates a message to `MAX_PLUGIN_MESSAGE_LENGTH` characters, ending it with
 * "..." if it was cut.
 *
 * A plugin's text has no length limit. Truncating here, where the message is
 * built, rather than in each reader, keeps every message within the published
 * maximum.
 */
export const truncateMessage = (message: string): string =>
  message.length <= MAX_PLUGIN_MESSAGE_LENGTH
    ? message
    : truncateText(message, MAX_PLUGIN_MESSAGE_LENGTH - 3);

/** Every issue a decode found, as one line naming the field each one is about. */
export const describeFieldIssues = (error: Schema.SchemaError): string =>
  truncateMessage(listDecodeIssues(error).map(formatIssue).join("; "));

/** The same, as the failure the registration surfaces declare. */
export const toPluginError = (error: Schema.SchemaError): PluginError =>
  new PluginError({ message: describeFieldIssues(error) });
