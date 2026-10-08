/**
 * Measures what the runner sends against `MAX_FRAME_BYTES`, the largest
 * message the controller accepts. The controller closes the socket on a larger
 * one, and that ends the stream of every session on the runner.
 */
import { MAX_FRAME_BYTES, type RunnerToController } from "@hercule/protocol";

const BYTES_PER_MIB = 1024 * 1024;

/**
 * Measures the bytes `frame` takes on the socket, as its UTF-8 JSON text.
 *
 * The socket sends `JSON.stringify` of the frame as the `RunnerToController`
 * schema encodes it. That encoding transforms no field: it may write the keys
 * in another order, but every value stays the same, so the byte count is the
 * same.
 */
export const measureFrameBytes = (frame: RunnerToController): number =>
  Buffer.byteLength(JSON.stringify(frame), "utf8");

/** Formats a byte count as MiB, rounded up so a size over the limit never reads as equal to it. */
const formatMiB = (bytes: number): string =>
  `${String(Math.ceil((bytes / BYTES_PER_MIB) * 100) / 100)} MiB`;

/**
 * Describes a size over the frame limit in words a user reads, for example
 * "4.01 MiB, too large to send (the limit is 2 MiB)", so every message about
 * an oversized frame words it the same way.
 */
export const describeExcessSize = (bytes: number): string =>
  `${formatMiB(bytes)}, too large to send (the limit is ${formatMiB(MAX_FRAME_BYTES)})`;
