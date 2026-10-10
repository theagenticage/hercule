/**
 * Moves images between this runner and the controller over plain HTTP, in
 * both directions:
 *
 * - the attachment cache fetches the images of an input and caches them on
 *   this machine, so an adapter can hand its harness a local file;
 * - the attachment uploader sends the controller each image from a tool's
 *   result, so the session's events carry only a reference to it.
 *
 * A frame on the runner socket carries only a reference to each image. The
 * bytes come over plain HTTP instead, each image on its own request, so a
 * 10 MiB image never delays the socket's events, approvals or other sessions.
 * The request carries the runner's credential, the same one the socket uses.
 *
 * Each image is cached once per session, at `<session's directory>/<id>`:
 *
 * - the bytes are written to a temporary file, checked against the
 *   reference's SHA-256, and only then renamed to the image's id, so a file
 *   under that name is always complete and checked;
 * - a cached file is used as it is, so an input delivered again after a
 *   reconnect does not fetch its images again;
 * - only one fetch per file runs at a time; a second request for the same
 *   file waits for the first;
 * - a response is refused when its length is not the reference's
 *   `sizeBytes`, and the transfer stops as soon as more bytes arrive than
 *   that, so a wrong or hostile response cannot fill the disk.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, renameSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { join as joinPath } from "node:path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  ATTACHMENT_DOWNLOAD_TIMEOUT,
  ToolResultAttachment,
  RUNNER_ATTACHMENTS_PATH,
  ATTACHMENT_UPLOAD_TIMEOUT,
  type AttachmentReference,
  type ToolResultImage,
} from "@hercule/protocol";
import type { LocalAttachment } from "../providers";
import { parseErrorEnvelopeMessage } from "../error-envelope";
import { truncateFact } from "../providers/text";

export interface AttachmentCache {
  /**
   * Returns each image as a file in `dir`, in the order of `references`,
   * fetching the ones not cached there yet, in parallel. `dir` must exist.
   * All of them together get `ATTACHMENT_DOWNLOAD_TIMEOUT`, which the controller
   * adds to its wait for the answer, so the fetch must end within it. Fails with a
   * message naming the first image that could not be fetched in time, or
   * whose bytes did not match its size or SHA-256.
   */
  readonly fetch: (
    dir: string,
    references: ReadonlyArray<AttachmentReference>,
  ) => Effect.Effect<ReadonlyArray<LocalAttachment>, string>;
}

/** Returns the message of an error, or the value itself as text. */
const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Returns `promise`, but rejects with the signal's reason as soon as `signal`
 * aborts. Lets a caller stop waiting for a fetch that another caller started.
 */
const settleBeforeAbort = <A>(promise: Promise<A>, signal: AbortSignal): Promise<A> =>
  new Promise<A>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });

/**
 * Creates the cache of attached images. Create it once per process: an
 * input's fetch can outlive the connection that delivered it, and a second
 * delivery on the next connection must wait for that fetch, not start another.
 */
export const makeAttachmentCache = (options: {
  readonly controllerUrl: string;
  readonly credential: string;
}): AttachmentCache => {
  /** The fetches running now, by the path of the file each one writes. */
  const running = new Map<string, Promise<void>>();

  /**
   * Fetches one image to `path`. Writes to a temporary file next to it and
   * renames that file to `path` only after the size and SHA-256 matched.
   * Aborting `signal` stops the request and the body stream. Throws an error
   * whose message says what went wrong.
   */
  const download = async (
    reference: AttachmentReference,
    path: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const url = new URL(`${RUNNER_ATTACHMENTS_PATH}/${reference.id}`, options.controllerUrl);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { authorization: `Bearer ${options.credential}` },
        signal,
      });
    } catch (error) {
      throw new Error(
        `the controller at ${url.origin} could not be reached: ${describeError(error)}`,
        { cause: error },
      );
    }
    if (!response.ok || response.body === null) {
      throw new Error(`the controller responded with HTTP ${String(response.status)}`);
    }
    const announced = response.headers.get("content-length");
    if (announced !== null && Number(announced) !== reference.sizeBytes) {
      await response.body.cancel();
      throw new Error(
        `the controller sent ${announced} bytes, but the image has ${String(reference.sizeBytes)}`,
      );
    }
    const temporary = `${path}.${randomUUID()}.partial`;
    const hash = createHash("sha256");
    let received = 0;
    const file = await open(temporary, "wx", 0o600);
    try {
      // Throwing from `write` cancels the body, so the transfer stops at the
      // first chunk past the image's size.
      await response.body.pipeTo(
        new WritableStream<Uint8Array>({
          write: async (chunk) => {
            received += chunk.byteLength;
            if (received > reference.sizeBytes) {
              throw new Error(
                `the controller sent more than the image's ${String(reference.sizeBytes)} bytes`,
              );
            }
            hash.update(chunk);
            await file.write(chunk);
          },
        }),
      );
      await file.close();
      if (hash.digest("hex") !== reference.sha256) {
        throw new Error("the bytes the controller sent do not match the image's checksum");
      }
      renameSync(temporary, path);
    } catch (error) {
      await file.close().catch(() => undefined);
      rmSync(temporary, { force: true });
      throw error;
    }
  };

  /** Returns the cached file of one image, fetching it first unless it is cached already. */
  const cacheOne = (
    dir: string,
    reference: AttachmentReference,
    signal: AbortSignal,
  ): Effect.Effect<LocalAttachment, string> => {
    const path = joinPath(dir, reference.id);
    return Effect.tryPromise({
      try: () => {
        if (existsSync(path)) return Promise.resolve();
        // A fetch that another input started keeps that input's deadline;
        // this input still stops waiting at its own.
        const pending = running.get(path);
        if (pending !== undefined) return settleBeforeAbort(pending, signal);
        const started = download(reference, path, signal).finally(() => running.delete(path));
        running.set(path, started);
        return started;
      },
      catch: (error) =>
        `the image "${reference.name}" could not be fetched from the controller: ${describeError(error)}`,
    }).pipe(Effect.as({ ...reference, path }));
  };

  return {
    fetch: (dir, references) =>
      Effect.suspend(() => {
        const signal = AbortSignal.timeout(Duration.toMillis(ATTACHMENT_DOWNLOAD_TIMEOUT));
        return Effect.forEach(references, (reference) => cacheOne(dir, reference, signal), {
          concurrency: "unbounded",
        });
      }),
  };
};

/**
 * Uploads the images from a tool's result to the controller, which stores
 * each one as an Attachment of the session. The runner replaces each image in
 * a tool's result with the reference this returns before the message becomes
 * an event, so no event carries an image's bytes.
 */
export interface AttachmentUploader {
  /**
   * Uploads one image from a tool's result to the controller, which
   * stores it for the session, and returns the reference to keep in the
   * image's place. Never fails: an upload that fails, is refused, or does not
   * finish within `ATTACHMENT_UPLOAD_TIMEOUT` returns the image as
   * `unavailable`, with the reason for the user.
   */
  readonly upload: (sessionId: string, bytes: Uint8Array) => Effect.Effect<ToolResultImage>;
}

const decodeToolResultAttachment = Schema.decodeUnknownSync(ToolResultAttachment);

/**
 * Creates the attachment uploader, which uploads each image from a tool's
 * result to the controller. The request carries the runner's
 * credential, the same one the socket uses, and the image's bytes as its body.
 */
export const makeAttachmentUploader = (options: {
  readonly controllerUrl: string;
  readonly credential: string;
}): AttachmentUploader => {
  /**
   * Uploads one image and returns the stored image. Throws an error whose
   * message the user can read. The controller reads the image's type from
   * its first bytes, so the request names no type.
   */
  const send = async (sessionId: string, bytes: Uint8Array): Promise<ToolResultAttachment> => {
    const url = new URL(RUNNER_ATTACHMENTS_PATH, options.controllerUrl);
    url.searchParams.set("sessionId", sessionId);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${options.credential}` },
        body: bytes,
        signal: AbortSignal.timeout(Duration.toMillis(ATTACHMENT_UPLOAD_TIMEOUT)),
      });
    } catch (error) {
      throw new Error(
        error instanceof DOMException && error.name === "TimeoutError"
          ? `the controller did not store it within ${Duration.format(ATTACHMENT_UPLOAD_TIMEOUT)}`
          : `the controller could not be reached: ${describeError(error)}`,
        { cause: error },
      );
    }
    if (response.status !== 201) {
      throw new Error(
        parseErrorEnvelopeMessage(await response.text().catch(() => "")) ??
          `the controller responded with HTTP ${String(response.status)}`,
      );
    }
    try {
      return decodeToolResultAttachment(await response.json());
    } catch (error) {
      throw new Error("the controller's answer was not a stored image", { cause: error });
    }
  };

  return {
    upload: (sessionId, bytes) =>
      Effect.match(Effect.tryPromise({ try: () => send(sessionId, bytes), catch: describeError }), {
        onSuccess: (attachment): ToolResultImage => ({ type: "image", attachment }),
        onFailure: (why): ToolResultImage => ({
          type: "image",
          unavailable: truncateFact(`The image could not be kept: ${why}`),
        }),
      }),
  };
};
