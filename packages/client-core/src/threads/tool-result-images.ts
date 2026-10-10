/**
 * Reads the images a tool returned out of its step's result content
 * (`WorkItem.resultContent`). The runner stores each image the tool returned
 * and leaves only a reference to it in the content, so a client reads the
 * bytes through `attachment.readContent` and never gets them with the
 * transcript.
 */
import { Schema } from "effect";
import { ToolResultImage } from "@hercule/contract";

const isToolResultImage = Schema.is(ToolResultImage);

/**
 * Returns the images in a step's result content, in the order the tool
 * returned them: each one either a stored image or the reason it could not
 * be kept. Returns `[]` when the content is not a list of blocks.
 *
 * Text blocks are skipped, and so is any entry that is not a well-formed
 * image reference, such as a raw image block from a transcript written
 * before images were stored by reference. A transcript from an older or
 * newer runner therefore still renders.
 */
export const readToolResultImages = (content: unknown): readonly ToolResultImage[] =>
  Array.isArray(content) ? (content as readonly unknown[]).filter(isToolResultImage) : [];
