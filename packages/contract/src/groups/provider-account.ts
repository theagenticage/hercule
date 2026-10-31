/**
 * Provider Accounts: one account at one Provider, such as a Claude
 * subscription on one machine or a Z.ai API key. Sessions run on an account,
 * in one of the harnesses its kind allows. The Provider and its Account Kinds
 * come from the registering plugin (`provider.ts`).
 *
 * The record shows who is signed in and what each runner last learned about
 * the account in each harness (its Capability Snapshots). It never shows a
 * credential: a key is written with `providerAccount.create` or
 * `providerAccount.update` and never read back.
 */
import { Schema } from "effect";
import { ModelDescriptor, SnapshotAuth } from "@hercule/protocol";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import {
  Conflict,
  Forbidden,
  Internal,
  InvalidState,
  NotFound,
  Unauthenticated,
  Validation,
} from "../errors";
import { Id, Timestamp } from "../ids";
import { Authenticated } from "../security";
import { bounded, SecretValue } from "../strings";
import { VersionVerdict } from "./harness";

/** Re-exported rather than copied, so the public shape cannot drift from the wire shape. */
export { ModelDescriptor, ModelOption, SnapshotAuth } from "@hercule/protocol";

/** The longest label an account may carry. */
export const MAX_PROVIDER_ACCOUNT_LABEL_LENGTH = 128;

const ProviderAccountLabel = bounded(1, MAX_PROVIDER_ACCOUNT_LABEL_LENGTH);

/** What one runner learned about one account in one harness, the last time it probed. */
export const CapabilitySnapshot = Schema.Struct({
  runnerId: Id,
  /** The qualified id of the harness that was probed. */
  harnessId: Schema.String,
  probedAt: Timestamp,
  harnessVersion: Schema.NullOr(Schema.String),
  versionVerdict: VersionVerdict,
  auth: SnapshotAuth,
  models: Schema.Array(ModelDescriptor),
});

export type CapabilitySnapshot = Schema.Schema.Type<typeof CapabilitySnapshot>;

export const ProviderAccount = Schema.Struct({
  id: Id,
  /** The qualified id of the Provider, such as `anthropic/anthropic`. */
  providerId: Schema.String,
  /** The id of one of the Provider's Account Kinds. It never changes. */
  kind: Schema.String,
  /** What the user calls the account; `null` when they gave no name. */
  label: Schema.NullOr(ProviderAccountLabel),
  /** Who is signed in, as the vendor names them (an email address); `null` before the first sign-in. */
  identity: Schema.NullOr(Schema.String),
  /** The plan the vendor reports, such as "Max"; `null` when none is known. */
  planLabel: Schema.NullOr(Schema.String),
  /** The qualified id of the harness a session uses when it names none. */
  defaultHarnessId: Schema.String,
  /**
   * When the account's token stops working. Set only for a kind whose
   * credential is a token Hercule minted (a Claude subscription token); `null`
   * for every other kind.
   */
  expiresAt: Schema.NullOr(Timestamp),
  snapshots: Schema.Array(CapabilitySnapshot),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export type ProviderAccount = Schema.Schema.Type<typeof ProviderAccount>;

/**
 * The payload of `providerAccount.create`. `kind` is one of the Provider's
 * Account Kinds. `credentials` holds the fields of the kind's `credentials`
 * setup step, such as `apiKey`: required for a kind that has that step and
 * refused for one that has not. A kind that signs in through its harness is
 * created without credentials and then signed in with `providerAccount.signIn`.
 * `defaultHarnessId` is the qualified id of the harness a session uses when it
 * names none; left out, it is the Provider's own harness, even when that
 * harness is installed on no runner yet. When given, it is refused when the
 * account cannot run in that harness and also when no runner has it installed.
 */
export const ProviderAccountCreateInput = Schema.Struct({
  providerId: Schema.String,
  kind: Schema.String,
  label: Schema.optionalKey(ProviderAccountLabel),
  defaultHarnessId: Schema.optionalKey(Schema.String),
  credentials: Schema.optionalKey(Schema.Record(Schema.String, SecretValue)),
});

export type ProviderAccountCreateInput = Schema.Schema.Type<typeof ProviderAccountCreateInput>;

/**
 * The payload of `providerAccount.update`. A field left out is not changed;
 * `label: null` removes the label. `defaultHarnessId` is the qualified id of
 * a harness the account can run in. `credentials` holds the fields of the
 * kind's `credentials` setup step, such as `apiKey`, and replaces the stored
 * ones.
 */
export const ProviderAccountUpdateInput = Schema.Struct({
  label: Schema.optionalKey(Schema.NullOr(ProviderAccountLabel)),
  defaultHarnessId: Schema.optionalKey(Schema.String),
  credentials: Schema.optionalKey(Schema.Record(Schema.String, SecretValue)),
});

export type ProviderAccountUpdateInput = Schema.Schema.Type<typeof ProviderAccountUpdateInput>;

/**
 * The machine a sign-in runs on. A vendor credential belongs to exactly one
 * machine, because with refresh-token rotation, two live copies of one login
 * log each other out.
 */
export const ProviderAccountSignInInput = Schema.Struct({ runnerId: Id });

export type ProviderAccountSignInInput = Schema.Schema.Type<typeof ProviderAccountSignInInput>;

/** A sign-in the runner started: what the user opens, and for a device login what they type there. */
export const ProviderAccountSignInStarted = Schema.Struct({
  url: Schema.String,
  /**
   * Present when the harness printed a code to type in the browser. Such a
   * device login finishes by itself: the account is probed again on that
   * runner when it ends, and announced on the `provider` topic.
   */
  userCode: Schema.optionalKey(Schema.String),
  /**
   * When the printed code stops being valid, at most a day after the call.
   * Present with `userCode`, unless the runner's build is too old to say.
   */
  expiresAt: Schema.optionalKey(Timestamp),
});

export type ProviderAccountSignInStarted = Schema.Schema.Type<typeof ProviderAccountSignInStarted>;

/**
 * The code the user copied from the browser they opened the URL in. It must
 * be a single line: it is written to the vendor CLI's stdin, where a second
 * line would be read as the answer to its next question.
 */
export const ProviderAccountSignInCodeInput = Schema.Struct({
  runnerId: Id,
  code: bounded(1, 512).check(
    Schema.isPattern(/^[^\r\n]+$/, {
      title: "code",
      description: "a single line",
    }),
  ),
});

export type ProviderAccountSignInCodeInput = Schema.Schema.Type<
  typeof ProviderAccountSignInCodeInput
>;

export const providerAccount = HttpApiGroup.make("providerAccount")
  .add(
    HttpApiEndpoint.get("query", "/provider-accounts", {
      success: Schema.Array(ProviderAccount),
      error: [Unauthenticated, Forbidden, Internal],
    }),
    HttpApiEndpoint.get("read", "/provider-accounts/:id", {
      params: { id: Id },
      success: ProviderAccount,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.post("create", "/provider-accounts", {
      payload: ProviderAccountCreateInput,
      success: ProviderAccount,
      error: [Unauthenticated, Forbidden, Validation, Conflict, InvalidState, Internal],
    }),
    HttpApiEndpoint.patch("update", "/provider-accounts/:id", {
      params: { id: Id },
      payload: ProviderAccountUpdateInput,
      success: ProviderAccount,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Conflict, InvalidState, Internal],
    }),
    HttpApiEndpoint.delete("delete", "/provider-accounts/:id", {
      params: { id: Id },
      success: Schema.Struct({}),
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    HttpApiEndpoint.post("signIn", "/provider-accounts/:id/sign-in", {
      params: { id: Id },
      payload: ProviderAccountSignInInput,
      success: ProviderAccountSignInStarted,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    HttpApiEndpoint.post("submitSignInCode", "/provider-accounts/:id/sign-in-code", {
      params: { id: Id },
      payload: ProviderAccountSignInCodeInput,
      success: ProviderAccount,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
  )
  .middleware(Authenticated);
