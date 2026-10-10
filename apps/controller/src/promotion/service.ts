/**
 * The promotion operation a user calls: `controller.createPromotionToken`
 * creates a 15-minute single-use token that lets another machine pull this
 * controller's data with `hercule promote`.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Forbidden, MintedPromotionToken, Unauthenticated } from "@hercule/contract";
import { requireUserActor, buildActorStamp } from "../actor";
import { nowIso, withTransaction } from "../db";
import { AuditLog } from "../events";
import { PromotionTokens } from "./tokens";

const make = Effect.gen(function* () {
  const tokens = yield* PromotionTokens;
  const audit = yield* AuditLog;
  const sql = yield* SqlClient.SqlClient;

  return {
    /**
     * Creates a promotion token, which invalidates any earlier unused one,
     * and returns it with its expiry. Fails with `Forbidden` for a caller
     * that is not the user.
     */
    createPromotionToken: (): Effect.Effect<
      MintedPromotionToken,
      Unauthenticated | Forbidden | SqlError
    > =>
      Effect.gen(function* () {
        const actor = yield* requireUserActor("controller.createPromotionToken");
        const at = yield* nowIso;
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const { id, token, expiresAt } = yield* tokens.create(at);
            yield* audit.append({
              kind: "controller.promotionToken.minted",
              actor: buildActorStamp(actor),
              payload: { promotionTokenId: id, expiresAt },
              at,
            });
            return { token, expiresAt };
          }),
        );
      }),
  };
});

export class PromotionService extends Context.Service<
  PromotionService,
  Effect.Success<typeof make>
>()("hercule/controller/promotion/PromotionService") {}

export const PromotionServiceLayer: Layer.Layer<
  PromotionService,
  never,
  PromotionTokens | AuditLog | SqlClient.SqlClient
> = Layer.effect(PromotionService)(make);
