/**
 * Model Profiles: named menus of models picked from the Provider Accounts,
 * one section per account. The composer offers exactly a profile's entries.
 *
 * This domain holds the rows, the rule for writing a whole profile, and the
 * resolution of each entry (its name, options and whether it can run now). It
 * also implements the `ModelProfileMembership` port that Provider Accounts
 * declares, so deleting an account and a first catalog read reach the profiles
 * without Provider Accounts importing this domain. It implements the
 * `ModelProfileLookup` port that Projects declares the same way. Projects
 * depend on nothing here, and this domain uses Projects to clear a deleted
 * profile from the projects that name it.
 */
export { ModelProfileLookupLayer } from "./lookup";
export { ModelProfileMembershipLayer } from "./membership";
export { modelProfileRepository, type StartingEntry, type StoredModelProfile } from "./repository";
export { ModelProfileService, ModelProfileServiceLayer, type UpdateInput } from "./service";
