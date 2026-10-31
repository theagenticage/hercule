/**
 * The Model Profiles side of the `ModelProfileLookup` port that Projects
 * declares: whether a profile exists. It reads the profile table alone and
 * does not use the Model Profile service, so Projects can depend on it
 * without a cycle between the two layers.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { ModelProfileLookup } from "../projects";
import { modelProfileRepository } from "./repository";

const make = Effect.gen(function* () {
  const profiles = yield* modelProfileRepository;
  return ModelProfileLookup.of({ exists: profiles.exists });
});

export const ModelProfileLookupLayer: Layer.Layer<ModelProfileLookup, never, SqlClient.SqlClient> =
  Layer.effect(ModelProfileLookup)(make);
