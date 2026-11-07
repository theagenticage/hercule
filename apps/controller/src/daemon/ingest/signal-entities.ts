import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { nowIso } from "../../db";
import { externalEntityRepository } from "../../external-entities";
import { SignalEntities } from "../../signals";

const make = Effect.gen(function* () {
  const entities = yield* externalEntityRepository;
  return SignalEntities.of({
    readByRefs: entities.readSignalEntities,
    recordArrivalAfter: (ref, write) =>
      Effect.flatMap(nowIso, (now) => entities.recordArrivalAfter(ref, now, write)),
  });
});

/**
 * Implements the signals domain's `SignalEntities` port from the External
 * Entity records: a signal list reads the entity of its threads through it,
 * and a raise reports an arrival through it. The external-entities domain
 * imports the signals domain, so the signals domain cannot import it back
 * without making the domain graph a cycle, and the controller daemon joins
 * the two. An arrival is recorded at the time of the call.
 */
export const SignalEntitiesLayer: Layer.Layer<SignalEntities, never, SqlClient.SqlClient> =
  Layer.effect(SignalEntities)(make);
