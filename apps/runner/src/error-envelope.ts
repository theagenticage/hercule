/**
 * Reads the error envelope the controller sends with a refused request. The
 * runner reads it on two routes outside the operation table, the join and the
 * upload of an image from a tool's result, so the shape is parsed here once.
 */

/**
 * Parses a response body as the controller's error envelope,
 * `{ error: { message } }`, and returns its message. Returns undefined when
 * the body is not JSON, has no such message, or the message is empty.
 */
export const parseErrorEnvelopeMessage = (body: string): string | undefined => {
  try {
    const envelope = JSON.parse(body) as { readonly error?: { readonly message?: unknown } } | null;
    const message = envelope?.error?.message;
    return typeof message === "string" && message !== "" ? message : undefined;
  } catch {
    // The body is not JSON, so something other than a controller probably
    // answered the request.
    return undefined;
  }
};
