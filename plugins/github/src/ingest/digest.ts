/**
 * Short digests for dedup keys. A key must stay under the host's limit of
 * 200 characters, so it cannot hold a list of label names or check suites,
 * but it must still change when that list changes.
 */
import { createHash } from "node:crypto";

/**
 * Returns the first 8 hex characters of the SHA-256 of `values`, in their
 * order. The same values always give the same digest. A caller sorts them
 * first when their order carries no meaning.
 */
export const computeDigest = (values: ReadonlyArray<string>): string =>
  createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 8);
