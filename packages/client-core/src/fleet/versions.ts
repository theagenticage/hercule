/**
 * Compares release versions by semantic-versioning precedence, for the Fleet
 * screens that say whether a tool is older than its latest release. This
 * module is private to `fleet/`: the screens reach it only through the
 * functions that word the result.
 */

interface ParsedVersion {
  readonly core: readonly [string, string, string];
  readonly preRelease: readonly string[];
}

/**
 * Three numbers, then an optional pre-release after a hyphen and optional
 * build metadata after a plus. A leading "v" is allowed, because publishers
 * tag releases that way.
 */
const SEMANTIC_VERSION =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const parseVersion = (version: string): ParsedVersion | undefined => {
  const match = SEMANTIC_VERSION.exec(version);
  if (match === null) return undefined;
  return {
    core: [match[1]!, match[2]!, match[3]!],
    preRelease: match[4] === undefined ? [] : match[4].split("."),
  };
};

/** Returns whether `text` is a version in the shape `compareReleaseVersions` can order. */
export const isReleaseVersion = (text: string): boolean => parseVersion(text) !== undefined;

const isNumeric = (identifier: string): boolean => /^\d+$/.test(identifier);

/** Orders two numbers written as digits. BigInt keeps a very long number exact. */
const compareNumbers = (a: string, b: string): number => {
  const difference = BigInt(a) - BigInt(b);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
};

/**
 * Orders two pre-release identifiers: numbers numerically, and a number below
 * any other identifier; other identifiers in ASCII order.
 */
const comparePreReleaseIdentifiers = (a: string, b: string): number => {
  if (isNumeric(a) && isNumeric(b)) return compareNumbers(a, b);
  if (isNumeric(a)) return -1;
  if (isNumeric(b)) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
};

/**
 * Compares two release versions by semantic-versioning precedence. Returns -1
 * when `a` is older than `b`, 1 when it is newer and 0 when they rank the
 * same. Returns `undefined` when either is not a version in that shape, such
 * as "go1.25" or "2.43", so the caller never guesses an order.
 *
 * - A leading "v" is ignored, and so is build metadata after a plus.
 * - A pre-release ranks below its release: "1.0.0-rc.1" is older than "1.0.0".
 * - Pre-release identifiers are compared one by one; when one list is a
 *   prefix of the other, the shorter one is older.
 */
export const compareReleaseVersions = (a: string, b: string): -1 | 0 | 1 | undefined => {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === undefined || right === undefined) return undefined;
  for (let index = 0; index < 3; index += 1) {
    const order = compareNumbers(left.core[index]!, right.core[index]!);
    if (order !== 0) return order as -1 | 1;
  }
  if (left.preRelease.length === 0 || right.preRelease.length === 0) {
    if (left.preRelease.length === right.preRelease.length) return 0;
    return left.preRelease.length === 0 ? 1 : -1;
  }
  const shared = Math.min(left.preRelease.length, right.preRelease.length);
  for (let index = 0; index < shared; index += 1) {
    const order = comparePreReleaseIdentifiers(left.preRelease[index]!, right.preRelease[index]!);
    if (order !== 0) return order as -1 | 1;
  }
  const lengthOrder = left.preRelease.length - right.preRelease.length;
  return lengthOrder < 0 ? -1 : lengthOrder > 0 ? 1 : 0;
};
