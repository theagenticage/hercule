/**
 * Takes the bytes of images, audio and embedded files out of a Codex
 * notification frame, before anything else reads it, so no event carries them.
 * Compare `claude-code-tool-result-images.ts`, which uploads the images of a
 * Claude tool result instead. Hercule does not keep the media of a Codex MCP
 * tool's result yet, so here they are only removed: the model already has its
 * own copy.
 *
 * A tool result can be megabytes of base64 that would be copied into every
 * event's `raw`, and the runner socket carries every session's events.
 */
import type { NotificationFrame } from "./rpc";

/**
 * The reason shown for an image of a Codex MCP tool's result: the model has
 * seen it, but Hercule does not keep it.
 */
const IMAGE_NOT_KEPT = "Hercule does not keep the images of a Codex MCP tool's result yet.";

/** What replaces the base64 of an audio block, of an embedded file, or of any copy of either. */
const BYTES_NOT_KEPT = "[bytes not kept]";

/**
 * Returns every thread item a notification frame holds. A `ThreadItem` sits in
 * the params of only these notifications: `item/started` and `item/completed`
 * hold it in `params.item`, and `turn/started` and `turn/completed` hold a
 * turn's items in `params.turn.items`. `thread/started` holds whole threads,
 * but it is dropped and never attached to an event. The items are returned as
 * they are, mutable, and unchecked: the caller goes by an item's `type` alone,
 * so an item whose other fields are malformed is covered too.
 */
const listFrameItems = (frame: NotificationFrame): ReadonlyArray<Record<string, unknown>> => {
  const params = frame.params as
    | { readonly item?: unknown; readonly turn?: { readonly items?: unknown } }
    | null
    | undefined;
  const turnItems = params?.turn?.items;
  return [
    params?.item,
    ...(Array.isArray(turnItems) ? (turnItems as ReadonlyArray<unknown>) : []),
  ].filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
};

/**
 * Returns `value` with every exact copy of the base64 strings in `copies`
 * replaced by `BYTES_NOT_KEPT`, at any depth. A string that holds a copy, such
 * as a data URL, keeps its other text. `copies` lists longer strings first, so
 * a copy that is part of a longer one cannot break the longer one up. Object
 * keys are scrubbed like strings. When two keys become the same text, the
 * later one gets a number, as `claude-code-tool-result-images.ts` does, so
 * neither field is lost. Fails with a `RangeError` when `value` is nested too
 * deeply for the stack.
 */
const scrubMediaCopies = (value: unknown, copies: ReadonlyArray<string>): unknown => {
  if (typeof value === "string") {
    return copies.reduce((text, copy) => text.replaceAll(copy, BYTES_NOT_KEPT), value);
  }
  if (Array.isArray(value)) return value.map((item) => scrubMediaCopies(item, copies));
  if (typeof value === "object" && value !== null) {
    const entries: Array<readonly [string, unknown]> = [];
    const keys = new Set<string>();
    for (const [key, field] of Object.entries(value)) {
      const scrubbed = scrubMediaCopies(key, copies) as string;
      let unique = scrubbed;
      for (let n = 2; keys.has(unique); n++) unique = `${scrubbed} (${String(n)})`;
      keys.add(unique);
      entries.push([unique, scrubMediaCopies(field, copies)]);
    }
    return Object.fromEntries(entries);
  }
  return value;
};

/**
 * The shortest value whose copies are scrubbed. A real image, sound or file is
 * hundreds of characters of base64 at least (the smallest PNG is about 90),
 * while a short value, such as a word a server also sends as text, is more
 * likely text than bytes. 64 characters sits below every real payload and
 * above any ordinary word.
 */
const MIN_SCRUBBED_LENGTH = 64;

/** Base64 as MCP carries it: the standard alphabet, with optional `=` padding. */
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Checks that `value` is worth scrubbing wherever it is copied: it looks like
 * base64 and is at least `MIN_SCRUBBED_LENGTH` long. A server controls the
 * `data` of its blocks, so without this check it could repeat a piece of its
 * own text as an image's `data` and make the scrub erase that text elsewhere.
 */
const looksLikeMediaBytes = (value: string): boolean =>
  value.length >= MIN_SCRUBBED_LENGTH && BASE64_PATTERN.test(value);

/** The parts of an MCP content block that can hold base64. */
interface MediaBlock {
  readonly type?: unknown;
  data?: unknown;
  readonly resource?: { blob?: unknown } | null;
}

/**
 * Removes the bytes of media from a notification frame, in place. Returns
 * nothing and never fails. The frame comes straight from the decoder, so
 * nothing else holds it yet.
 *
 * - An `imageGeneration` item holds the generated image, base64 encoded, in
 *   `result`. The field is removed, because the image reaches nobody through
 *   the stream.
 * - An `mcpToolCall` item holds MCP's content blocks in `result.content`. An
 *   image block is replaced by an `unavailable` image (see `ToolResultImage`).
 *   The base64 of an audio block's `data` and of an embedded resource's `blob`
 *   is replaced by a placeholder, and its `mimeType` and `uri` stay. Every
 *   other copy of that base64 in the result, such as one in
 *   `structuredContent` or `_meta`, is replaced too. Text blocks stay. Only a
 *   value that looks like base64 and is long enough counts as bytes (see
 *   `looksLikeMediaBytes`), so a short text is never erased.
 *
 * A result too deeply nested to walk is dropped whole, so no bytes stay.
 */
export const removeMediaBytes = (frame: NotificationFrame): void => {
  for (const item of listFrameItems(frame)) {
    if (item["type"] === "imageGeneration") Reflect.deleteProperty(item, "result");
    if (item["type"] !== "mcpToolCall") continue;
    const content = (item["result"] as { readonly content?: unknown } | null | undefined)?.content;
    if (!Array.isArray(content)) continue;
    const copies = new Set<string>();
    for (const [index, block] of content.entries()) {
      const media = block as MediaBlock | null;
      if (media?.type === "image") {
        if (typeof media.data === "string" && looksLikeMediaBytes(media.data)) {
          copies.add(media.data);
        }
        content[index] = { type: "image", unavailable: IMAGE_NOT_KEPT };
      } else if (media?.type === "audio" && typeof media.data === "string") {
        if (looksLikeMediaBytes(media.data)) copies.add(media.data);
        media.data = BYTES_NOT_KEPT;
      } else if (media?.type === "resource" && typeof media.resource?.blob === "string") {
        if (looksLikeMediaBytes(media.resource.blob)) copies.add(media.resource.blob);
        media.resource.blob = BYTES_NOT_KEPT;
      }
    }
    if (copies.size === 0) continue;
    try {
      item["result"] = scrubMediaCopies(
        item["result"],
        [...copies].toSorted((a, b) => b.length - a.length),
      );
    } catch {
      Reflect.deleteProperty(item, "result");
    }
  }
};
