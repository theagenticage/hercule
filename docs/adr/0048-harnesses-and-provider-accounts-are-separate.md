# 48. Harnesses and provider accounts are separate

Date: 2026-10-30

## Status

Accepted by [Harness × model source: the provider model (#404)](https://github.com/theagenticage/hercule/issues/404), with the prototype of [#405](https://github.com/theagenticage/hercule/issues/405), written into the spec by [#406](https://github.com/theagenticage/hercule/issues/406). Amends [ADR 0007](./0007-provider-adapter-is-a-thin-interface-behind-a-normalized-event-stream.md), [0015](./0015-secrets-are-encrypted-per-value-under-a-keychain-held-master-key.md), [0028](./0028-provider-harnesses-are-runner-installed-executables.md), [0030](./0030-sessions-copy-their-configuration-and-a-thread-has-no-agent.md), [0034](./0034-a-catalog-contribution-is-identified-by-its-qualified-id.md), [0041](./0041-text-generation-is-one-model-call-on-a-runner.md) and [0044](./0044-a-text-generation-step-is-a-third-step-kind.md), each of which carries a dated note.

## Context

Until now a **Provider** was the adapter for a harness (Claude Code, Codex, pi), and a **Provider Instance** was one account of that harness: its config, its secret fields, its vendor login on each runner, and a capability snapshot per runner. That ties one harness to one model source. In practice many model sources run in many harnesses:

- a ChatGPT subscription works in Codex and in pi;
- GLM is sold by Z.ai, by OpenRouter and by OpenCode, and all three run in pi;
- an Anthropic API key works in Claude Code and in pi.

Three more problems came from the same coupling:

- pi was hardwired to Z.ai.
- A per-machine login meant every new runner had to be signed in by hand.
- The composer listed every model of every instance, a menu too long to use.

The research behind this decision is on four branches: `research/desktop-settings-providers` (#403), `research/fleet-sign-in`, `research/model-catalogs` and `research/usage-sources`. The prototype is on `prototype/desktop-settings-providers`.

## Decision

**A Harness is the agent program. A Provider is the company that serves the models and bills for them. A Provider Account is one account at one provider. A Model Profile is a named model menu, picked from the accounts.**

- **The names.** "Provider" changes meaning, from the harness adapter to the company that serves the models. The rename of the old meaning to Harness lands first, alone and with no change in behaviour, so that afterwards "provider" has one meaning only. Until it lands, older spec text and the code still say "provider" for the harness.
- **A model is identified by (Provider Account, the provider's own model id).** No identity across accounts: GLM 5.3 from Z.ai and from OpenRouter are two entries in two sections. A harness translates an account's model into its own arguments and environment: `--model zai/glm-5.3` with `ZAI_API_KEY` in pi, `-m gpt-6.1-sol` in Codex.
- **What a Provider owns, and what a Harness owns.**
  - A provider plugin declares its Account Kinds (API key, a subscription signed in on each machine, a subscription token held for every machine), how an account's Model Catalog and Account Usage are read, which harnesses each kind may run in (a Claude subscription only in Claude Code), its Default Selection, and the small model it suggests for Text Generation.
  - A harness plugin declares which providers and kinds it runs, how, and which of a provider's models it can run.
- **Sign-in methods are declared, never drawn per provider.** An Account Kind lists setup steps from the fixed set Connection types already use (credentials, an OAuth redirect, a device code), with the same core OAuth2 client and secret handling, plus one step only providers need: signing in on a runner through the harness. A provider that adds OAuth later changes no screen.
- **Who holds the credentials.**
  - API keys and the Claude subscription token are held by the controller and sent with each frame, so they work on every runner.
  - Hercule obtains the token itself, by running `claude setup-token` on a runner.
  - Claude's `/login` and Codex's ChatGPT login stay per machine.
  - One account is one person at the provider: a sign-in as someone else is refused.
- **Our reading of Anthropic's terms.** Hercule hands a subscription credential only to the vendor's unmodified harness, and never calls a vendor with one itself. Subscription usage is read through the harness for the same reason.
- **Sessions run on a Provider Account, a harness and a model.** A thread's account and harness are fixed when it starts; only its model changes.
- **One Harness Home per account, per harness, per runner.** Existing homes never move, because:
  - Codex stores absolute transcript paths in its own database and never corrects them;
  - on macOS, Claude Code names its Keychain login after a hash of the config folder's path.

  A migrated account keeps its old folder as a legacy home. One function decides every account's home, and it is the only code that reads the legacy folder.
- **Model Catalogs are per account and stored on the controller.** Each is read the way its provider says: through the vendor's harness on a runner, or from the provider's API with the key. The latest successful read counts. Catalogs are refreshed every four hours, and a failed read keeps the last good list. No third-party catalog is used.
- **Model Profiles are the composer's menus.** Each profile holds accounts and their models in order, with a default entry. The harness is chosen at three levels: the account's default, then per account in a profile, then per model. An account joining a profile brings its Default Selection, and a model new to that selection is announced, never added by itself. A Project may name one Model Profile: this is the one default a Project carries, an exception to the GLOSSARY's "no behaviour, no defaults", decided by Rogier.
- **Account Usage has one owner.** One controller domain holds each account's latest windows or credit, and everything that shows usage reads it there.
- **A Provider Account is not a Connection.** The two share how a credential is obtained, and nothing else: event ingest and acting-as belong to Connections; homes, catalogs, usage and profiles belong to accounts.

## Considered options

- **More kinds of Provider Instance**, one per harness and source pair (pi with OpenRouter, pi with OpenCode). Rejected: the pairs multiply, and one subscription would need one login per harness.
- **A shared model identity across sources**, such as models.dev, to show "GLM 5.3" once with a source picker. Rejected: nothing in the design needs it, and it adds a third-party dependency.
- **A Provider Account as a kind of Connection.** Rejected: the overlap is only in obtaining a credential, which the shared setup steps already cover.
- **Moving old homes into the new layout.** Rejected for the two harness facts above. A symlink scheme was also rejected: it would last as long as the legacy column does, with the trick spread across disk and runner code.
- **Profiles that follow the vendor's list by themselves.** Rejected for announcing new models and letting the user add them, so the user keeps control of the menu.

## Consequences

- The migration rewrites rows, so it carries an upgrade-test fixture. Secrets are encrypted with their owner kind, id and name as associated data, so moving a value to its Provider Account is a decrypt and re-encrypt inside the migration.
- The Android app is installed on its own. A release that stops requiring `instanceId` ships before the controller drops it.
- Rate-limit waiting ([#625](https://github.com/theagenticage/hercule/issues/625)) reads the usage domain instead of building its own.
