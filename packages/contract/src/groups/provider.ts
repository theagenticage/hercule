/**
 * Providers: the companies that serve models and bill for them, such as
 * Anthropic, OpenAI and Z.ai. A Provider is a plugin contribution, so this
 * group only reads. What a user creates is a Provider Account, in
 * `provider-account.ts`.
 */
import { Schema } from "effect";
import { AccountKind } from "@hercule/plugin-host";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import { Forbidden, Internal, Unauthenticated } from "../errors";
import { Authenticated } from "../security";

/** Re-exported rather than copied, so the public shape cannot drift from what a plugin declares. */
export { AccountKind, AccountSetupStep } from "@hercule/plugin-host";

export const Provider = Schema.Struct({
  /** The qualified id, such as `zai/zai`. */
  id: Schema.String,
  /** The id of the plugin that registered the Provider, such as `zai`. Clients read it here and never split it off `id` (ADR 0034). */
  pluginId: Schema.String,
  displayName: Schema.String,
  /** The qualified id of the harness a new account of this Provider starts with, such as `claude-code/claude-code`. */
  defaultHarnessId: Schema.String,
  kinds: Schema.Array(AccountKind),
});

export type Provider = Schema.Schema.Type<typeof Provider>;

export const provider = HttpApiGroup.make("provider")
  .add(
    HttpApiEndpoint.get("query", "/providers", {
      success: Schema.Array(Provider),
      error: [Unauthenticated, Forbidden, Internal],
    }),
  )
  .middleware(Authenticated);
