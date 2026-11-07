/**
 * The loop that gives pending claims a ref.
 *
 * A claim whose thing no plugin could place when it was reported (a Linear
 * link in a GitHub description, `SHOP-123` in a ticket, a web address nobody
 * knew) holds a pending target. This loop reads the thing through
 * `EntityLookups.resolve`, with the same rules as the Add button: never the
 * first match, and an ambiguous or incomplete answer leaves the claim pending.
 * Found rewrites the claim's target to the canonical ref and keeps its type
 * and Connection.
 *
 * It runs here and not inside the plugin host because the host builds the
 * ingest loops and the lookups need the host. Lookups take seconds, so they
 * run outside any transaction, and each result is written in its own short one
 * (`ClaimResolution.settle`). The Connection that reported the claim is never
 * touched: a failed lookup says nothing about it.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { EntityRecognition } from "@hercule/plugin-host";
import {
  ClaimResolution,
  decodePendingTarget,
  encodePendingTarget,
  type ClaimResolutionOutcome,
  type PendingClaim,
  type PendingTarget,
} from "../../external-entities";
import { EntityLookups, type DecidedResolution } from "../../plugins";
import { PromotionState } from "../../promotion";
import { nowIso } from "../../db";
import { absorbFailures } from "../../absorbing";

/** The most pending claims one Connection has resolved in one pass. */
export const MAX_CLAIMS_PER_CONNECTION_PER_PASS = 20;

/**
 * How long the loop waits between passes. A pass with nothing due is one
 * indexed statement, and the shortest backoff of a claim is 120 seconds, so
 * a short wait costs almost nothing and keeps a new claim from waiting long
 * for its first try.
 */
const CLAIM_RESOLVER_INTERVAL: Duration.Duration = Duration.seconds(30);

/** The wait between passes. Tests override it with a shorter one. */
export const ClaimResolverInterval = Context.Reference<Duration.Duration>(
  "hercule/controller/daemon/ClaimResolverInterval",
  { defaultValue: (): Duration.Duration => CLAIM_RESOLVER_INTERVAL },
);

/** Converts a scoped pending target to the recognition the lookup reads. */
const buildRecognition = (
  target: Extract<PendingTarget, { form: "scoped" }>,
): EntityRecognition => ({
  recognized: "scoped",
  form: "identifier",
  ...(target.kind === undefined ? {} : { kind: target.kind }),
  identifier: target.identifier,
  ...(target.scopeHint === undefined ? {} : { scopeHint: target.scopeHint }),
});

const UNPLACED: ClaimResolutionOutcome = { kind: "unplaced" };

/**
 * Runs one pass: settles up to `MAX_CLAIMS_PER_CONNECTION_PER_PASS` due claims
 * of each Connection. Two claims with the same pending target are read once.
 * Never fails on a lookup: an answer that does not place the thing postpones
 * the claim.
 */
export const resolvePendingClaims: Effect.Effect<void, never, ClaimResolution | EntityLookups> =
  Effect.gen(function* () {
    const resolution = yield* ClaimResolution;
    const lookups = yield* EntityLookups;
    const now = yield* nowIso;
    const due = yield* Effect.orDie(
      resolution.listDue({ now, perConnection: MAX_CLAIMS_PER_CONNECTION_PER_PASS }),
    );
    if (due.length === 0) return;

    // One read per pending target in a pass, however many claims hold it.
    const readTargets = new Map<string, DecidedResolution>();
    const read = (pluginId: string, recognition: EntityRecognition, key: string) =>
      Effect.gen(function* () {
        const known = readTargets.get(key);
        if (known !== undefined) return known;
        const decided = yield* lookups.resolve(pluginId, recognition);
        readTargets.set(key, decided);
        return decided;
      });

    const settle = (claim: PendingClaim, expectedTarget: string, outcome: ClaimResolutionOutcome) =>
      Effect.orDie(resolution.settle({ claimId: claim.id, expectedTarget, outcome }));

    for (const claim of due) {
      const decoded = decodePendingTarget(claim.target);
      if (decoded === undefined) {
        yield* settle(claim, claim.target, UNPLACED);
        continue;
      }
      let target = claim.target;
      let scoped: Extract<PendingTarget, { form: "scoped" }>;
      if (decoded.form === "url") {
        // A plugin may have become active since the address was reported.
        const recognitions = yield* lookups.recognize(decoded.url);
        const found = recognitions.find(({ recognition }) => recognition.form === "url");
        if (found === undefined) {
          yield* settle(claim, target, UNPLACED);
          continue;
        }
        if (found.recognition.recognized === "ref") {
          yield* settle(claim, target, { kind: "found", ref: found.recognition.ref });
          continue;
        }
        scoped = {
          form: "scoped",
          pluginId: found.pluginId,
          ...(found.recognition.kind === undefined ? {} : { kind: found.recognition.kind }),
          ...(found.recognition.scopeHint === undefined
            ? {}
            : { scopeHint: found.recognition.scopeHint }),
          identifier: found.recognition.identifier,
        };
        const encoded = encodePendingTarget(scoped);
        if (encoded === undefined) {
          yield* settle(claim, target, UNPLACED);
          continue;
        }
        yield* settle(claim, target, { kind: "recognized", target: encoded });
        target = encoded;
      } else {
        scoped = decoded;
      }

      const decided = yield* read(scoped.pluginId, buildRecognition(scoped), target);
      yield* settle(
        claim,
        target,
        "found" in decided ? { kind: "found", ref: decided.found.observation.ref } : UNPLACED,
      );
    }
  });

/**
 * Resolves pending claims, then again after each `ClaimResolverInterval`.
 * Never returns. A pass that fails is logged, and the next one runs. A pass
 * runs only while the controller serves.
 *
 * Pending web addresses are made due again when the set of plugins that
 * recognize addresses changes, so an address nobody knew is read again as
 * soon as a plugin that knows it is enabled.
 */
export const runClaimResolverLoop: Effect.Effect<
  never,
  never,
  ClaimResolution | EntityLookups | PromotionState
> = Effect.gen(function* () {
  const resolution = yield* ClaimResolution;
  const lookups = yield* EntityLookups;
  const interval = yield* ClaimResolverInterval;
  const promotion = yield* PromotionState;
  let knownLinkSources: string | undefined;
  while (true) {
    yield* absorbFailures(
      "Resolving pending claims failed",
      promotion.whenServing(
        Effect.gen(function* () {
          const linkSources = (yield* lookups.listLinkSources()).join(",");
          if (linkSources !== knownLinkSources) {
            knownLinkSources = linkSources;
            yield* Effect.orDie(resolution.makeUrlClaimsDue());
          }
          yield* resolvePendingClaims;
        }),
      ),
    );
    yield* Effect.sleep(interval);
  }
});
