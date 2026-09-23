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
  cutShort,
  describeIssue,
  listDecodeIssues,
  MAX_PLUGIN_MESSAGE_LENGTH,
} from "@hercule/contract";

/**
 * Cutting a plugin's unbounded text where the message is made, rather than at
 * each reader, is what makes the published maximum true of every message. The
 * cut leaves room for the three dots that end a message that was cut.
 */
export const truncateMessage = (message: string): string =>
  message.length <= MAX_PLUGIN_MESSAGE_LENGTH
    ? message
    : cutShort(message, MAX_PLUGIN_MESSAGE_LENGTH - 3);

/** Every issue a decode found, as one line naming the field each one is about. */
export const describeFieldIssues = (error: Schema.SchemaError): string =>
  truncateMessage(listDecodeIssues(error).map(describeIssue).join("; "));

/** The same, as the failure the registration surfaces declare. */
export const asPluginError = (error: Schema.SchemaError): PluginError =>
  new PluginError({ message: describeFieldIssues(error) });
