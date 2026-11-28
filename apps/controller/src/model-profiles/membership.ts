/**
 * The Model Profiles side of the `ModelProfileMembership` port that Provider
 * Accounts declares: what a profile does when an account is deleted and when
 * an account's first Model Catalog read lands.
 *
 * It works on the rows alone. It does not use the Model Profile service, so
 * Provider Accounts can depend on it without a cycle between the two layers.
 * All three methods run inside the caller's transaction. The two that change
 * profiles raise the revision of each profile they change by one, so a client
 * holding the old revision is refused `conflict` and reads the profile again.
 * The third only reads.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { nowIso } from "../db";
import { ModelProfileMembership, type DefaultHarnessClash } from "../provider-accounts";
import {
  fillPendingSections,
  findModelsClashingOnDefaultHarness,
  removeAccountFromBody,
} from "./profile-body";
import { modelProfileRepository } from "./repository";

const make = Effect.gen(function* () {
  const profiles = yield* modelProfileRepository;

  return ModelProfileMembership.of({
    /**
     * Takes the account out of every profile: its section, its dismissed
     * models, and a default entry that was its own (the first remaining entry
     * becomes the default, or none when nothing remains).
     */
    removeProviderAccount: (providerAccountId) =>
      Effect.gen(function* () {
        const at = yield* nowIso;
        for (const profile of yield* profiles.list()) {
          const body = removeAccountFromBody(profile.body, providerAccountId);
          if (body !== null) yield* profiles.save(profile.id, { name: profile.name, body, at });
        }
      }).pipe(Effect.catchTag("SchemaError", Effect.die)),

    /**
     * Fills every section of the account that is waiting for its first
     * catalog with `selection`. A profile with no default entry takes the
     * selection's default model, else its first entry. Returns whether any
     * profile changed.
     */
    fillPendingSelections: (providerAccountId, selection) =>
      Effect.gen(function* () {
        const at = yield* nowIso;
        let changed = false;
        for (const profile of yield* profiles.list()) {
          const body = fillPendingSections(profile.body, providerAccountId, selection);
          if (body === null) continue;
          yield* profiles.save(profile.id, { name: profile.name, body, at });
          changed = true;
        }
        return changed;
      }).pipe(Effect.catchTag("SchemaError", Effect.die)),

    /**
     * Lists, for each profile, the models of the account's sections that
     * would appear twice in a section if `defaultHarnessId` became the
     * account's default harness.
     */
    findDefaultHarnessClashes: (providerAccountId, defaultHarnessId) =>
      Effect.gen(function* () {
        const clashes: Array<DefaultHarnessClash> = [];
        for (const profile of yield* profiles.list()) {
          for (const section of profile.body.accounts) {
            if (section.providerAccountId !== providerAccountId) continue;
            for (const model of findModelsClashingOnDefaultHarness(section, defaultHarnessId)) {
              clashes.push({ profileName: profile.name, model });
            }
          }
        }
        return clashes;
      }).pipe(Effect.catchTag("SchemaError", Effect.die)),
  });
});

export const ModelProfileMembershipLayer: Layer.Layer<
  ModelProfileMembership,
  never,
  SqlClient.SqlClient
> = Layer.effect(ModelProfileMembership)(make);
