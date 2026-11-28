import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { WorkflowEntities } from "../../workflows";

/**
 * Provides the workflows domain's `WorkflowEntities` from the external
 * entities table. It lives in the controller daemon because the external
 * entities domain depends on the workflows domain, so neither domain can
 * connect the two without a cycle. It reads the table with one statement and
 * does not use the External Entity service.
 */
export const WorkflowEntitiesLayer: Layer.Layer<WorkflowEntities, never, SqlClient.SqlClient> =
  Layer.effect(WorkflowEntities)(
    Effect.map(SqlClient.SqlClient, (sql) => ({
      readKind: (ref: string) =>
        Effect.map(
          sql<{ readonly kind: string }>`SELECT kind FROM external_entities WHERE ref = ${ref}`,
          (rows) => Option.map(Option.fromNullishOr(rows[0]), (row) => row.kind),
        ),
    })),
  );
