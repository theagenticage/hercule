/**
 * Reads the two item details every adapter shares: an `unknown` item's label
 * and a `context_compaction` item's trigger, token counts and summary. Both
 * shapes are schemas in `@hercule/contract`; this file is the one place a
 * client decodes them, so the desktop's rows and the web's rows can never read
 * one item differently.
 *
 * A detail that does not decode, such as one written before the shape existed,
 * reads as having nothing in it. The row is then drawn from its kind alone.
 */
import { Option, Schema } from "effect";
import { ContextCompactionDetail, UnknownItemDetail } from "@hercule/contract";
import { formatTokenCount } from "../subagents/describe";

const decodeCompactionDetail = Schema.decodeUnknownOption(ContextCompactionDetail);
const decodeUnknownItemDetail = Schema.decodeUnknownOption(UnknownItemDetail);

/**
 * Returns the compaction detail `detail` holds, or `undefined` when it is
 * absent or does not decode. A decoded detail may have no fields at all.
 */
export const readCompactionDetail = (detail: unknown): ContextCompactionDetail | undefined =>
  Option.getOrUndefined(decodeCompactionDetail(detail));

/**
 * Returns the words after "Compacted the context" for a compaction item's
 * `detail`, such as "182k → 31k tokens (auto)":
 *
 * - both counts known: "182k → 31k tokens";
 * - only the count before known: "from 182k tokens";
 * - only the count after known: "to 31k tokens";
 * - the trigger, "(auto)" or "(manual)", follows when it is known;
 * - "" when no count is known, whatever the trigger. A compaction with no
 *   numbers reads just "Compacted the context".
 *
 * Returns "" for a detail that does not decode, such as one written by an
 * older runner.
 */
export const describeCompactionTarget = (detail: unknown): string => {
  const { trigger, tokensBefore, tokensAfter } = readCompactionDetail(detail) ?? {};
  const before = tokensBefore === undefined ? undefined : formatTokenCount(tokensBefore);
  const after = tokensAfter === undefined ? undefined : formatTokenCount(tokensAfter);
  const size =
    before !== undefined && after !== undefined
      ? `${before} → ${after} tokens`
      : before !== undefined
        ? `from ${before} tokens`
        : after !== undefined
          ? `to ${after} tokens`
          : "";
  return size === "" || trigger === undefined ? size : `${size} (${trigger})`;
};

/** Returns the summary a compaction item's `detail` holds, or "" when it holds none. */
export const readCompactionSummary = (detail: unknown): string =>
  readCompactionDetail(detail)?.summary ?? "";

/**
 * Returns the label an `unknown` item's `detail` holds, such as
 * `claude: system/foo_bar`, or "" when it holds none. A row written before
 * the label existed holds none.
 */
export const readUnknownLabel = (detail: unknown): string =>
  Option.getOrUndefined(decodeUnknownItemDetail(detail))?.label ?? "";
