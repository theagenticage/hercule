/**
 * Builds the error messages a plugin gets when something it registered is
 * invalid.
 *
 * Every such message is built here, so all of them stay within the published
 * maximum length, and an invalid field is described the same way wherever it
 * was declared. This is a leaf module: it knows the message formats and
 * nothing about the host or the catalog.
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

/** Formats every issue a decode found as one line, naming the field of each issue. */
export const describeFieldIssues = (error: Schema.SchemaError): string =>
  truncateMessage(listDecodeIssues(error).map(formatIssue).join("; "));

/** Converts a decode error to the `PluginError` that registration fails with. */
export const toPluginError = (error: Schema.SchemaError): PluginError =>
  new PluginError({ message: describeFieldIssues(error) });
