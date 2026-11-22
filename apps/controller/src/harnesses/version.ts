/**
 * Compares a reported harness version against this build's two limits: the
 * floor, the oldest version a runner may run, and the tested maximum, the
 * newest version anyone has tested. For Claude Code and Codex both are the
 * version the build was made against; pi has a tested maximum above its
 * floor. They change only when the dependency or the tests change, which is
 * why the verdict is computed at read time rather than stored with the
 * snapshot.
 */
import type { VersionVerdict } from "@hercule/contract";
import {
  CLAUDE_CODE_VERSION,
  CODEX_VERSION,
  PI_TESTED_VERSION,
  PI_VERSION,
} from "@hercule/home/version";

/** The oldest version a runner may run, and the newest version anyone has tested. */
interface VersionLimits {
  readonly floor: string;
  readonly testedMax: string;
}

/**
 * The harnesses this build pins a version for, by qualified id. Other
 * harnesses' versions are recorded but not compared.
 */
const LIMITS: ReadonlyMap<string, VersionLimits> = new Map([
  ["claude-code/claude-code", { floor: CLAUDE_CODE_VERSION, testedMax: CLAUDE_CODE_VERSION }],
  ["codex/codex", { floor: CODEX_VERSION, testedMax: CODEX_VERSION }],
  ["pi/pi", { floor: PI_VERSION, testedMax: PI_TESTED_VERSION }],
]);

/**
 * Parses the first three dot-separated components of a version as numbers, so
 * 10 sorts after 9 rather than before it. Returns `undefined` if there are not
 * three numeric components.
 */
const parseVersionParts = (version: string): ReadonlyArray<number> | undefined => {
  const parts = version.split(".", 3).map((part) => Number.parseInt(part, 10));
  return parts.length === 3 && parts.every(Number.isInteger) ? parts : undefined;
};

/** Returns a negative number when `left` is older than `right`, positive when newer, 0 when equal. */
const compareVersionParts = (left: ReadonlyArray<number>, right: ReadonlyArray<number>): number => {
  for (const [index, part] of left.entries()) {
    const against = right[index]!;
    if (part !== against) return part - against;
  }
  return 0;
};

/**
 * Returns how a reported version compares with the floor and the tested
 * maximum: `below-floor` when older than the floor, `above-tested-max` when
 * newer than the tested maximum, otherwise `ok`. Returns `unknown` when there
 * is no version or no limit, or when a version cannot be parsed.
 */
export const computeVersionVerdict = (
  harnessVersion: string | null,
  floor: string | null,
  testedMax: string | null,
): VersionVerdict => {
  if (harnessVersion === null || floor === null || testedMax === null) return "unknown";
  const running = parseVersionParts(harnessVersion);
  const least = parseVersionParts(floor);
  const most = parseVersionParts(testedMax);
  // A version that cannot be parsed, on any side, is treated the same as no
  // version.
  if (running === undefined || least === undefined || most === undefined) return "unknown";
  if (compareVersionParts(running, least) < 0) return "below-floor";
  return compareVersionParts(running, most) > 0 ? "above-tested-max" : "ok";
};

/**
 * Returns the verdict on a version a runner reported for a harness, against
 * the limits this build pins for that harness. Returns `unknown` for a
 * harness with no pinned limits.
 */
export const computeHarnessVersionVerdict = (
  harnessId: string,
  harnessVersion: string | null,
): VersionVerdict => {
  const limits = LIMITS.get(harnessId);
  return computeVersionVerdict(harnessVersion, limits?.floor ?? null, limits?.testedMax ?? null);
};

/**
 * Returns the floor this build pins for a harness, the oldest version a runner
 * may run, such as `1.3.0`. Returns `undefined` for a harness with no pinned
 * limits.
 */
export const readHarnessFloor = (harnessId: string): string | undefined =>
  LIMITS.get(harnessId)?.floor;
