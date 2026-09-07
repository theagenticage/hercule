/**
 * How the harness version a runner reported stands against what this build was
 * tested with.
 *
 * The floor is a compatibility number rather than a policy: the SDK compiled
 * into this binary talks to the CLI it was built against and to anything newer,
 * so that CLI's version is both the least a machine may run and the most
 * anybody has tested. It moves only when the dependency moves.
 *
 * The verdict is computed here at read time rather than stored, because the
 * floor belongs to the build and the version belongs to the row: a snapshot
 * taken before an upgrade would otherwise keep yesterday's answer.
 */
import type { VersionVerdict } from "@hydra/contract";
import { CLAUDE_CODE_VERSION } from "@hydra/home/version";

/** The providers this build pins a version to. The rest are read but not judged. */
const FLOORS: ReadonlyMap<string, string> = new Map([["claude-code", CLAUDE_CODE_VERSION]]);

export const floorFor = (providerId: string): string | null => FLOORS.get(providerId) ?? null;

/** The leading numeric components, so 10 sorts after 9 rather than before it. */
const partsOf = (version: string): ReadonlyArray<number> | undefined => {
  const parts = version.split(".", 3).map((part) => Number.parseInt(part, 10));
  return parts.length === 3 && parts.every(Number.isInteger) ? parts : undefined;
};

export const versionVerdict = (
  harnessVersion: string | null,
  floor: string | null,
): VersionVerdict => {
  if (harnessVersion === null || floor === null) return "unknown";
  const running = partsOf(harnessVersion);
  const least = partsOf(floor);
  // A version neither side can read is a fact with nothing to compare it
  // against, which is the same answer as having reported none.
  if (running === undefined || least === undefined) return "unknown";
  for (const [index, part] of running.entries()) {
    const against = least[index]!;
    if (part !== against) return part < against ? "below-floor" : "above-tested-max";
  }
  return "ok";
};
