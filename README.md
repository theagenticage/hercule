# Hercule

A self-hosted agent orchestration platform. One always-on **controller** holds all state and makes every orchestration decision; **runners** on any number of machines host agent sessions driven by interactive coding harnesses (Claude Code, Codex, pi); everything else - the web app, the `hercule` CLI, and the agents themselves - is a client of one public API.

Five features define v1:

1. **Controller/runner split** - orchestrate from one place, execute anywhere.
2. **Event-triggered workflows** - GitHub, Gmail, cron, and platform events start and resume runs through one persisted pipeline.
3. **Workflows as stored definitions** - editable in the controller; each run freezes its own immutable execution plan.
4. **Assistants with memory** - agents bound to Discord and Slack that remember across conversations.
5. **Agents operate everything the user can** - through the same public API, bounded by permission profiles.

The value center is **Intake**: agents triage, group, and enrich incoming signals into prepared Proposals before the user sees them, so decisions are made on high-value material rather than raw input.

Hercule is the successor to agentick (Python), built from scratch in TypeScript. Nothing is imported.

## Status

**Implementing v1.** The v1 spec was assembled 2026-08-28 from the decisions worked as child issues of the [wayfinder map](https://github.com/theagenticage/hercule/issues/1); remaining open items are indexed in [docs/spec/16-open-items.md](docs/spec/16-open-items.md), each tied to a follow-up ticket or marked as an implementer's choice.

## Install

On a Mac with Apple silicon or on Linux (x86_64 and aarch64):

```sh
curl -fsSL https://raw.githubusercontent.com/theagenticage/hercule/edge/install.sh | sh
```

This installs a build of `main`, from the rolling `edge` prerelease that every push to `main` replaces once CI passes. It is a dev build, not a stable release: stable releases come with [#191](https://github.com/theagenticage/hercule/issues/191) and [#102](https://github.com/theagenticage/hercule/issues/102).

The script installs:

- the `hercule` binary at `~/.local/bin/hercule`. When `~/.local/bin` is not on your `PATH`, it prints the line to add to your shell profile.
- on macOS, the desktop app at `/Applications/Hercule.app`.

A first install starts nothing, because only you know what this machine is for. To run the controller on it:

```sh
hercule service install
hercule setup-url
```

The first command installs a service unit (a LaunchAgent on macOS, a systemd user unit on Linux) that runs `hercule serve` and restarts it when it stops. The second prints the URL to open to set up the controller. To make this machine a runner of a controller on another machine instead, run the join command from the Fleet's "Add machine" in that controller's web app; it installs the service unit for `hercule runner` itself.

Either way, Hercule keeps everything in the Hercule Home, which is `~/.hercule` unless `HERCULE_HOME` is set. Its logs are `logs/controller.log` and `logs/runner.log` there. `hercule service status` says whether the service is running; `hercule service stop`, `start`, `restart` and `uninstall` do what they say.

**Linux-specific notes:**

- **Lingering:** When `loginctl enable-linger` fails during installation, run `sudo loginctl enable-linger <user>` first. This lets the service run without a login session.
- **Networked controller:** For a controller that other machines reach, set `bind.host` in `~/.hercule/config.toml`:

  ```toml
  [bind]
  host = "192.168.1.10"  # LAN IP, or your Tailscale IP for a tailnet
  port = 4937
  ```

  Then restart the service with `hercule service restart`. The service reads `config.toml` alone. See [spec 15 §1](docs/spec/15-packaging-and-operations.md#1-distribution) for more details.

**To update, run the same line again.** It replaces the binary and the app together, so the two always agree, and restarts the service. The restart ends any turn in progress, so update when no agent is working. The controller migrates its database itself when it starts, and keeps a copy from before the migration in the Hercule Home's `backups/`.

If your desktop app was installed before the app was signed with a certificate, the first update asks you to sign in once more, because the Keychain sees a different app ([docs/signing-certificate.md](docs/signing-certificate.md)). Later updates keep the sign-in.

## Moving the controller to another machine

Promotion pulls the controller's data onto a new machine under the same identity. Runners follow automatically.

On the old machine (A), create a token:

```sh
hercule controller promotion-token create
```

It prints the command to run on the new machine (B), with the token filled in. `--from` is the URL the CLI reached A at; when that is a loopback address such as `127.0.0.1`, which B cannot reach, the command holds a placeholder for you to replace with A's URL as B reaches it. The token works once, for 15 minutes, and creating another invalidates it. On B, with an empty Hercule Home, run it:

```sh
hercule promote --from <A-url> --token <token> --address <B-url>
```

`--address` is B's URL as runners reach it. It is required when B binds loopback or a wildcard. `--yes` skips the confirm prompt. `--no-service` skips installing the Service Unit and runs the controller in the foreground.

Promote while no agent is working: while A copies its data it refuses changes, and a session event a runner reports between the copy and its reconnect to B is lost.

After the pull, A seals and tells every connected runner to reconnect to B. A runner that missed the announcement and dials A gets a signed forwarding pointer. If promote fails after the pull, it says what happened to both machines. Usually A serves again and B's Home is emptied, so you create a new token and run promote again.

Clients do not follow on their own. A sealed A answers them with B's address, and you point each one at B:

- **CLI**: `hercule login <B-url> --username <name>`. Your password and API keys moved with the data, so they work on B.
- **Desktop app**: sign out (Settings > Profile, or the app menu), choose **Change** next to "Connected to" on the sign-in screen, enter B's URL, and sign in.
- **Web app**: open B's URL.

To serve on A again after a promotion (disaster recovery only):

```sh
hercule serve --force-unseal
```

If A is gone and a runner never heard the announcement, re-point it by hand: `hercule runner set-controller <B-url>`.

## Documentation

| Where | What |
|---|---|
| [docs/spec/](docs/spec/README.md) | The normative v1 spec: one document per subsystem, buildable without opening the tickets |
| [docs/adr/](docs/adr/) | Architecture decision records - the "why" behind the spec |
| [CONTEXT.md](CONTEXT.md) | The ubiquitous language: every domain term, with the synonyms to avoid |
| [docs/design-language.md](docs/design-language.md) | The visual language and pinned UI semantics for all surfaces |
| [AGENTS.md](AGENTS.md) | Instructions for coding agents working in this repo |

Start with [the overview](docs/spec/01-overview-and-scope.md): what ships, what doesn't, and a walk of one event through the whole system.

## Tech

TypeScript throughout, one repository. The controller and runner are written on [Effect 4](https://effect.website) with Effect Schema as the contract language ([ADR 0031](docs/adr/0031-the-backend-is-written-on-effect.md)); state lives in one SQLite database ([ADR 0004](docs/adr/0004-controller-state-lives-in-one-sqlite-database.md)); everything ships as one self-contained Bun binary ([ADR 0018](docs/adr/0018-hercule-ships-as-one-self-contained-binary.md)). The web app is a static SPA and a pure client of the public API ([ADR 0017](docs/adr/0017-the-web-app-is-a-static-pure-client-of-the-public-api.md)).

Research findings land on `research/*` branches under `research/`; prototype code on `prototype/*` branches.
