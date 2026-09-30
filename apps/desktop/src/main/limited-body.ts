/**
 * Reads a response body that main did not ask for the size of. Main reads
 * bodies from servers the user named, or from any process listening on a
 * loopback port, and such a server can send a body that never ends.
 */

/**
 * The longest body main reads. The answers main expects are a few bytes; the
 * limit stops an endpoint that streams without end from filling main's
 * memory.
 */
const BODY_LIMIT_BYTES = 64 * 1024;

/**
 * Reads the body of `response` as text, or returns null as soon as it is
 * longer than 64 KiB, and then stops reading it. Returns "" for a response
 * with no body. Fails when reading the body fails.
 */
export const readLimitedBody = async (response: Pick<Response, "body">): Promise<string | null> => {
  if (response.body === null) return "";
  const chunks: Array<Uint8Array> = [];
  let length = 0;
  // A fetch body is a stream of bytes; Node's types leave the chunk untyped.
  for await (const chunk of response.body as ReadableStream<Uint8Array>) {
    length += chunk.byteLength;
    // Leaving the loop cancels the stream.
    if (length > BODY_LIMIT_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};
