# 34. A catalog contribution is identified by its qualified id

Date: 2026-09-13

## Status

Accepted. Decided by [Connections and the core OAuth2 client (#71)](https://github.com/rogierpennink/hydra/issues/71), landed in [PR #175](https://github.com/rogierpennink/hydra/pull/175). Refines [ADR 0006](./0006-plugins-request-capabilities-and-register-contributions-in-code.md) (contributions are registered in code and named by id) and [ADR 0010](./0010-external-accounts-are-core-owned-connections.md) (connection types are plugin-defined).

## Context

A plugin registers contributions into the catalog and each one needs a name the rest of the system can hold: a Connection row names a connection type, a channel binding names a channel contribution, a session spec names a provider. [Spec 05](../spec/05-plugins.md) said those names are "namespaced by the defining plugin" without saying what the namespaced name *is*, so the first implementation took the plugin's declared word as the identity - the `github` plugin declares a `github` connection type, and `github` is what the API takes, what the row stores, and what a filter matches.

That only works if a word has one owner across all installed plugins, and nothing makes it so. Implementing #71 forced the question twice: the plugin host had to decide what to do when two plugins declare the same word, and the connection service had to decide how it finds the plugin that owns a type in order to run its setup flow. Both had to invent a rule the spec does not contain, and the rule they reached for - refuse to boot on a duplicate word - is a coordination problem with no coordinator. Two people write a Gmail plugin; one of them cannot be installed. The provider registry showed the other end of the same failure: it checks for duplicate ids only within one plugin, so two plugins declaring `claude-code` both load and the lookup map silently keeps whichever registered last.

## Decision

**A catalog contribution is identified by its qualified id, `<pluginId>/<word>`.** The plugin declares the bare word (`type: "github"`, a provider `id: "claude-code"`); the plugin host mints the qualified id at registration (`github/github`) and that is the identity everywhere downstream: the catalog, the public API, stored rows, filters.

- **Nobody parses the string.** Every lookup keys on the qualified form, and where the owning plugin is needed it comes from the registered catalog entry, not from splitting on the slash. The format is for humans reading a row, and for nothing else.
- **The bare word may not contain `/`**, so the qualified form is unambiguous. That is the only validation the word carries.
- **No boot-time uniqueness check exists**, because identity is unique by construction: two plugins may declare the same word and both load. Two Gmail plugins in a marketplace are a normal, supported situation and the user sees two connection types with two owners.
- **Request bodies carry the qualified id in the one field that already exists.** `connection.create` takes `type: "github/github"`; there is no second `pluginId` field, and a Connection row carries no separate plugin id.

Analogy, for a reader who wants one: npm `@scope/name` and Docker `owner/image`. The scope is part of the name, not metadata beside it.

## Scope

**Connection types adopt this now**, in PR #175.

**Providers follow in their own ticket.** A provider id is not only a catalog key: it travels to runners in install and login payloads and keys the version-floor policy for harness installs, so moving it to the qualified form touches the controller-runner protocol ([ADR 0028](./0028-provider-harnesses-are-runner-installed-executables.md), [spec 15](../spec/15-packaging-and-operations.md) §12). Provider ids stay bare until that ticket, and until then the last-wins bug above stands, known.

Workflow action and channel contribution ids are unaffected: they already carry the owning plugin as a dotted prefix (`github.merge`), a spelling [spec 05](../spec/05-plugins.md) §1 pins from the tickets. Whether the two spellings converge is not decided here.

## Considered options

- **A global word namespace with boot refusal**: one word, one owner, checked when the catalog is built; a second plugin declaring `gmail` refuses to load. Rejected because it is a coordination problem forever - every plugin author must know every other plugin's words, with no registry to consult - and because it is unenforceable where it matters most: the current provider path has no such check at all and silently keeps the last registration, which is the same collision resolved by coin flip.
- **A pair of fields, `pluginId` + `type`, in request bodies and on the Connection row**: honest about what identity consists of, and needs no new spelling. Rejected because the two fields only mean anything together - every filter, every lookup and every foreign key would have to carry both and keep them consistent - and `type` is a word this codebase already spends on discriminated unions, so a body carrying both `pluginId` and `type` reads as if `type` were the union tag.

## Consequences

- The mismatch branches disappear. There is no "this connection's type belongs to a different plugin" case to handle, because a type names its plugin; a lookup either finds a registered contribution or does not.
- The word a plugin declares is the plugin's own business, so a plugin can be renamed-by-forking without asking anyone's permission, and the marketplace never needs a name authority.
- A qualified id changes if the plugin id changes, which makes a plugin id rename a data migration over stored rows. Plugin ids are already stable identity ([spec 05](../spec/05-plugins.md) §2, the namespace for KV and secrets), so this adds no new constraint - it adds one more thing that depends on it.
- Users see `github/github`, which reads redundantly for the common case of a plugin whose single contribution shares its name. The catalog carries a `displayName` for every contribution and the UI shows that; the qualified id is what the API and the rows speak.
- Until the provider ticket lands, the codebase has two identity rules for catalog contributions. That is stated, not hidden: see Scope.
