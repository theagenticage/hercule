import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Id } from "@hercule/contract";

/**
 * A record in another domain that names a Connection and would break if the
 * Connection were deleted:
 *
 * - `resource`: a resource acts through the Connection, with its credentials.
 *   `resourceName` is the repo's remote, or the folder's or mailbox's label,
 *   and `null` for a folder or mailbox whose label was cleared.
 * - `trigger`: a workflow's trigger starts runs only on events from the
 *   Connection. Without the Connection no event could match the trigger
 *   again, and nothing would tell the user why their workflow went quiet.
 */
export type ConnectionReference =
  | {
      readonly kind: "resource";
      readonly resourceId: string;
      readonly resourceName: string | null;
    }
  | {
      readonly kind: "trigger";
      readonly workflowId: string;
      readonly triggerId: string;
      readonly workflowName: string;
    };

/**
 * What the connections domain needs to know before it deletes a Connection:
 * which records in other domains still name it.
 *
 * Those records are not read here directly. The resources and workflows
 * domains both depend on the connections domain, so the connections domain
 * cannot import them back without making the domain graph a cycle. So the
 * connections domain declares what it needs as this service, and the
 * controller daemon provides it from those domains (`ConnectionReferencesLayer`).
 * This is the second step of the cycle ladder in ADR 0033: invert the control.
 */
export class ConnectionReferences extends Context.Service<
  ConnectionReferences,
  {
    /**
     * Returns every record that names the Connection: the resources first,
     * then the triggers, each sorted by name. Runs in the caller's
     * transaction, so a delete that checks first sees the same rows as the
     * delete itself.
     */
    readonly list: (
      connectionId: Id,
    ) => Effect.Effect<ReadonlyArray<ConnectionReference>, SqlError>;
  }
>()("hercule/controller/connections/ConnectionReferences") {}
