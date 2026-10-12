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
import { formatIssue, listDecodeIssues, truncateMessage } from "@hercule/contract";

/** Formats every issue a decode found as one line, naming the field of each issue. */
export const describeFieldIssues = (error: Schema.SchemaError): string =>
  truncateMessage(listDecodeIssues(error).map(formatIssue).join("; "));

/** Converts a decode error to the `PluginError` that registration fails with. */
export const toPluginError = (error: Schema.SchemaError): PluginError =>
  new PluginError({ message: describeFieldIssues(error) });
