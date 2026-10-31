/**
 * Model Profiles: a named menu of models, picked from the Provider Accounts.
 * A profile holds one section per account, and each section lists the models
 * of that account the user wants in the menu, in the order they want them.
 * The composer offers exactly these entries.
 *
 * A stored entry names only an account, a model and optionally a harness.
 * What the menu needs to draw it (the model's name, its options, and whether
 * it can run now) is worked out by the controller on every read and returned
 * on the `ResolvedModelProfileEntry`, so no client repeats that logic.
 *
 * A profile is created empty or as a copy of another, and deleted unless it
 * is the last one. A project may name one profile (`Project.modelProfileId`).
 */
import { Schema } from "effect";
import { ImageInputCapability, MAX_FACT_LENGTH, ModelOption } from "@hercule/protocol";
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
import { atMost, bounded } from "../strings";
import { ModelSlug } from "./settings";

/** The longest name a Model Profile may carry. */
export const MAX_MODEL_PROFILE_NAME_LENGTH = 128;

const ModelProfileName = bounded(1, MAX_MODEL_PROFILE_NAME_LENGTH);

/**
 * The most Model Profiles there can be. `modelProfile.query` returns every
 * profile with every entry resolved, and every client loads it, so the count
 * is bounded. `modelProfile.create` is refused `invalid_state` at this count.
 */
export const MAX_MODEL_PROFILES = 32;

/** The most accounts (sections) one `modelProfile.update` may send. */
export const MAX_MODEL_PROFILE_ACCOUNTS = 64;

/** The most entries one section of a `modelProfile.update` may send. */
export const MAX_MODEL_PROFILE_SECTION_ENTRIES = 256;

/** The most dismissed models one `modelProfile.update` may send. */
export const MAX_DISMISSED_NEW_MODELS = 1024;

/**
 * A qualified harness id a client writes into a profile. It is at most as long
 * as a model slug, so one that fits here can always be sent to a runner.
 */
const HarnessId = bounded(1, MAX_FACT_LENGTH);

/**
 * One model in a profile, as it is stored and as a client writes it.
 *
 * `harnessId` is the qualified id of the harness this entry runs in. `null`
 * means the entry follows its section's harness, and that in turn follows the
 * account's default harness. An entry that names its own harness is how one
 * model is offered twice, once in each harness.
 */
export const ModelProfileEntry = Schema.Struct({
  providerAccountId: Id,
  /** The model's slug in the account's Model Catalog. */
  model: ModelSlug,
  harnessId: Schema.NullOr(HarnessId),
});

export type ModelProfileEntry = Schema.Schema.Type<typeof ModelProfileEntry>;

/**
 * Why a profile entry cannot run now.
 *
 * - `not-signed-in`, `credential-missing`, `token-expired`, `harness-missing`
 *   and `harness-too-old`: the account is not ready in the entry's harness on
 *   any connected runner. These are the states of `ProviderAccountReadiness`,
 *   and the one reported is the most actionable among the runners.
 * - `harness-not-allowed`: the account's kind may not run in the entry's
 *   harness, because the provider's terms or the harness do not allow it.
 *   Nothing the user does on a machine fixes it; the entry needs another
 *   harness.
 * - `no-runner`: no runner is connected (online, not draining and not retired).
 * - `model-left-catalog`: the account's Model Catalog has been read and no
 *   longer lists the model. The entry is kept, so it comes back if the model
 *   does.
 * - `harness-lacks-model`: the entry's harness lists its own models, and its
 *   latest good probe of the account does not list this one.
 */
export const EntryProblemReason = Schema.Literals([
  "not-signed-in",
  "credential-missing",
  "token-expired",
  "harness-missing",
  "harness-too-old",
  "harness-not-allowed",
  "no-runner",
  "model-left-catalog",
  "harness-lacks-model",
]);

export type EntryProblemReason = Schema.Schema.Type<typeof EntryProblemReason>;

/** What stops an entry from running, with a short sentence a user can act on. */
export const EntryProblem = Schema.Struct({
  reason: EntryProblemReason,
  message: Schema.String,
});

export type EntryProblem = Schema.Schema.Type<typeof EntryProblem>;

/**
 * A profile entry as a client reads it: the stored entry plus what the
 * controller worked out for it.
 */
export const ResolvedModelProfileEntry = Schema.Struct({
  ...ModelProfileEntry.fields,
  /**
   * The qualified id of the harness a session started from this entry runs
   * in: the entry's own `harnessId`, else its section's, else the account's
   * default harness. A client starts the session with this value, so the
   * harness a user sees is the harness that runs.
   */
  resolvedHarnessId: Schema.String,
  /** The model's name in the account's Model Catalog; the model's slug when the catalog does not list it. */
  name: Schema.String,
  /**
   * The model's choices (effort, thinking and the like) as `resolvedHarnessId`
   * reports them for this account in its latest good probe. Empty when there
   * is none.
   */
  options: Schema.Array(ModelOption),
  /** Whether the model takes images, and how large; `null` when it takes none or this is not known. */
  imageInput: Schema.NullOr(ImageInputCapability),
  /** What stops the entry from running now; `null` when it can run. */
  problem: Schema.NullOr(EntryProblem),
});

export type ResolvedModelProfileEntry = Schema.Schema.Type<typeof ResolvedModelProfileEntry>;

/**
 * A model that joined its account's Default Selection after the account's
 * first Model Catalog read, and that the profile has neither taken in nor
 * dismissed. A client offers it as "New" with Add and Not now.
 *
 * `firstSeenAt` is when the controller first saw the model in the account's
 * catalog, which is when it arrived.
 */
export const NewModel = Schema.Struct({
  model: ModelSlug,
  /** The model's name in the account's Model Catalog. */
  name: Schema.String,
  firstSeenAt: Timestamp,
});

export type NewModel = Schema.Schema.Type<typeof NewModel>;

/**
 * One account's section of a profile, as a client reads it.
 *
 * `harnessId` is the harness the section's entries run in unless an entry
 * names its own; `null` means the account's default harness.
 */
export const ResolvedModelProfileAccount = Schema.Struct({
  providerAccountId: Id,
  harnessId: Schema.NullOr(Schema.String),
  /**
   * The qualified id of the harness the section's entries run in unless an
   * entry names its own: the section's `harnessId`, else the account's default
   * harness.
   */
  resolvedHarnessId: Schema.String,
  /**
   * `true` while the section waits for the account's first successful Model
   * Catalog read, which fills it with the Provider's Default Selection. Its
   * `entries` are empty meanwhile. It turns `false` the moment the read
   * lands, so a client shows "reading models" rather than an empty menu.
   */
  selectionPending: Schema.Boolean,
  entries: Schema.Array(ResolvedModelProfileEntry),
  /**
   * The models to announce as new in this section, in the order of the
   * account's Default Selection. A model is listed while the section holds no
   * entry of it (in any harness) and the profile has not dismissed it. Empty
   * while `selectionPending`, and for a provider whose Default Selection is
   * empty.
   */
  newModels: Schema.Array(NewModel),
});

export type ResolvedModelProfileAccount = Schema.Schema.Type<typeof ResolvedModelProfileAccount>;

/**
 * A model the user took out of a profile, or declined when it appeared. The
 * profile does not announce it as new again.
 */
export const DismissedNewModel = Schema.Struct({
  providerAccountId: Id,
  model: ModelSlug,
});

export type DismissedNewModel = Schema.Schema.Type<typeof DismissedNewModel>;

/** A Model Profile: a named, ordered menu of models, a default among them, and what was dismissed. */
export const ModelProfile = Schema.Struct({
  id: Id,
  /** Unique among the profiles. */
  name: ModelProfileName,
  /**
   * Counts the writes to the profile, starting at 1. `modelProfile.update`
   * carries the revision the caller read, and is refused `conflict` when the
   * profile has changed since.
   */
  revision: Schema.Int,
  /** The sections in menu order. */
  accounts: Schema.Array(ResolvedModelProfileAccount),
  /** The entry a new Thread starts on when the user picks none; `null` while the profile has no entry. */
  defaultEntry: Schema.NullOr(ModelProfileEntry),
  dismissedNewModels: Schema.Array(DismissedNewModel),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export type ModelProfile = Schema.Schema.Type<typeof ModelProfile>;

/**
 * One account's section in a `modelProfile.update`.
 *
 * `entries` is optional. A section sent without `entries` gets its Provider's
 * Default Selection: applied now when the account's Model Catalog has been
 * read, otherwise when its first read succeeds. `entries: []` means no
 * entries and is kept as that.
 */
export const ModelProfileAccountInput = Schema.Struct({
  providerAccountId: Id,
  harnessId: Schema.NullOr(HarnessId),
  entries: Schema.optionalKey(atMost(ModelProfileEntry, MAX_MODEL_PROFILE_SECTION_ENTRIES)),
});

export type ModelProfileAccountInput = Schema.Schema.Type<typeof ModelProfileAccountInput>;

/**
 * The payload of `modelProfile.update`. It replaces the whole profile: every
 * field is required (a section's `entries` excepted), and the stored profile
 * becomes exactly what is sent. `expectedRevision` is the revision the caller
 * read; a different current revision refuses the write with `conflict`.
 *
 * The lists are bounded: at most `MAX_MODEL_PROFILE_ACCOUNTS` sections, at
 * most `MAX_MODEL_PROFILE_SECTION_ENTRIES` entries in a section, and at most
 * `MAX_DISMISSED_NEW_MODELS` dismissed models.
 */
export const ModelProfileUpdateInput = Schema.Struct({
  expectedRevision: Schema.Int,
  name: ModelProfileName,
  accounts: atMost(ModelProfileAccountInput, MAX_MODEL_PROFILE_ACCOUNTS),
  defaultEntry: Schema.NullOr(ModelProfileEntry),
  dismissedNewModels: atMost(DismissedNewModel, MAX_DISMISSED_NEW_MODELS),
});

export type ModelProfileUpdateInput = Schema.Schema.Type<typeof ModelProfileUpdateInput>;

/**
 * The payload of `modelProfile.create`. The profile starts empty, or with the
 * accounts, entries, harness choices, default entry and dismissed models of
 * the profile `copyFromId` names, as they are stored. A name another profile
 * has is refused `validation`.
 */
export const ModelProfileCreateInput = Schema.Struct({
  name: ModelProfileName,
  copyFromId: Schema.optionalKey(Id),
});

export type ModelProfileCreateInput = Schema.Schema.Type<typeof ModelProfileCreateInput>;

export const modelProfile = HttpApiGroup.make("modelProfile")
  .add(
    HttpApiEndpoint.get("query", "/model-profiles", {
      success: Schema.Array(ModelProfile),
      error: [Unauthenticated, Forbidden, Internal],
    }),
    HttpApiEndpoint.get("read", "/model-profiles/:id", {
      params: { id: Id },
      success: ModelProfile,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.post("create", "/model-profiles", {
      payload: ModelProfileCreateInput,
      success: ModelProfile,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    HttpApiEndpoint.patch("update", "/model-profiles/:id", {
      params: { id: Id },
      payload: ModelProfileUpdateInput,
      success: ModelProfile,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Conflict, Internal],
    }),
    HttpApiEndpoint.delete("delete", "/model-profiles/:id", {
      params: { id: Id },
      success: Schema.Struct({}),
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
  )
  .middleware(Authenticated);
