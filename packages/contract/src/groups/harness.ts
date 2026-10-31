/**
 * Harnesses: the agent programs sessions run in, such as Claude Code, Codex
 * and pi. A harness is a plugin contribution, so its description comes from the
 * registering plugin; only what each runner reports about it (is it installed,
 * which version) varies at read time. The accounts that sign in to a harness's
 * models are Provider Accounts, in `provider-account.ts`.
 */
import { Schema } from "effect";
import { DeclaredCapabilities } from "@hercule/plugin-host";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import { Forbidden, Internal, Unauthenticated } from "../errors";
import { Id } from "../ids";
import { Authenticated } from "../security";

/** Re-exported so a reader of a harness needs only this package. */
export { DeclaredCapabilities } from "@hercule/plugin-host";

/**
 * How the harness version a runner reported compares with the versions this
 * build was tested with. `unknown` means the machine reported no version, or
 * the harness has no minimum version set.
 */
export const VersionVerdict = Schema.Literals(["unknown", "below-floor", "ok", "above-tested-max"]);

export type VersionVerdict = Schema.Schema.Type<typeof VersionVerdict>;

/** What one runner reports about one harness. */
export const HarnessOnRunner = Schema.Struct({
  runnerId: Id,
  /** Whether the harness's binary is on the machine's `PATH`. */
  installed: Schema.Boolean,
  /** The version the machine reported; `null` when it is not installed or reported none. */
  version: Schema.NullOr(Schema.String),
  versionVerdict: VersionVerdict,
});

export type HarnessOnRunner = Schema.Schema.Type<typeof HarnessOnRunner>;

export const Harness = Schema.Struct({
  /** The qualified id, such as `claude-code/claude-code`. */
  id: Schema.String,
  displayName: Schema.String,
  /** The harness's executable name on a machine's `PATH`, which is how Runner Facts refer to it. */
  binaryName: Schema.String,
  declared: DeclaredCapabilities,
  /** One entry per runner the controller knows, in the order the runners were added. */
  runners: Schema.Array(HarnessOnRunner),
});

export type Harness = Schema.Schema.Type<typeof Harness>;

export const harness = HttpApiGroup.make("harness")
  .add(
    HttpApiEndpoint.get("query", "/harnesses", {
      success: Schema.Array(Harness),
      error: [Unauthenticated, Forbidden, Internal],
    }),
  )
  .middleware(Authenticated);
