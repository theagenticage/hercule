# 32. Threads link the user's own material, live and wholesale

Date: 2026-09-02

## Status

Accepted. Decided by [User knowledge in Hercule sessions](https://github.com/theagenticage/hercule/issues/52). Refines [ADR 0030](./0030-sessions-copy-their-configuration-and-a-thread-has-no-agent.md) (the Thread is where the exception lives) and the isolation rule of 06 §9.1; leaves [ADR 0028](./0028-provider-harnesses-are-runner-installed-executables.md) untouched.

**Amended 2026-10-04 ([#75](https://github.com/theagenticage/hercule/issues/75)):** v1 builds a minimum of this decision, so that Hercule can be built with Hercule. Four facts below have changed.

- **The source is the default install locations on the local runner.** Nothing is stored and nothing is detected: there is no `userMaterialDir`, and no first-run detection sets one. The runner reads each harness's default locations on its own machine: `~/.claude`, `CODEX_HOME` or `~/.codex`, `~/.pi/agent`, and `~/.agents/skills`. The controller decides which sessions get them. It sets a flag on a session's start frame only for a Thread placed on its local runner, and the runner follows the flag. A Thread on any other runner runs plain, and the composer does not say so yet. Both are accepted gaps.
- **Not wholesale yet.** Claude links only `skills/`, `agents/`, `commands/`, `rules/` and `CLAUDE.md`. `settings.json` and `plugins/` are deferred, because they would add the user's hooks and permission rules to every Thread. That is a bigger trust step than skills and instructions. So v1 ships the trimmed cut that the Context section rejects, as a first step: wholesale is deferred, not reversed. Both consequences accepted in the Decision still hold, by a narrower route. The user's skills, agents and commands can let tools run without an approval card while they are active: through a skill's or command's `allowed-tools`, a skill's or agent's `hooks:`, and an agent's `permissionMode`, exactly as in the user's own Claude Code (06 §9.1 lists the routes). And any Claude session of the instance, not only the Thread, can write through the links into the real `~/.claude`; that is not new reach, because Claude sessions keep the real `HOME`. Both are the parity this decision wants: no half-sandbox. A Thread also trusts the shared instance home as its "user" settings source, so a file another session of the instance writes there reaches the next Thread. `strictMcpConfig` stays on and auto memory stays off for Threads too.
- **Codex and pi take the material per process, not by link.** One instance has one home, shared by every session of that instance, and both harnesses read an instructions file from that home in every session. Codex always reads `AGENTS.md` from `CODEX_HOME`, and nothing turns that off. pi reads `AGENTS.md` from its agent dir in every session that has context files on. A link there would reach assistant sessions and workflow steps too. So a Codex Thread keeps the real `HOME`, which finds `~/.agents/skills`, and gets the user's instructions file in its `developerInstructions`; a pi Thread gets explicit `--skill`, `--prompt-template` and `--append-system-prompt` flags. Claude can take links because it reads those files from its config dir only when `settingSources` includes `"user"`, and only a Thread asks for it.
- **The fence is one importer.** The runner module that resolves the default locations is imported only by the session context resolver, which calls it only for a frame with the flag. A dep-lint rule fails the build when any other file imports it.

Everything else stands: Threads and only Threads see the material; it is read live at every start and never copied; every other session kind stays isolated; and shape (3) stays the named destination. A stored source, detection, the composer's state, remote runners and the rest of wholesale are later work (06 §9.1 Post-v1). Keeping the user's skills in sync across every runner is [#312](https://github.com/theagenticage/hercule/issues/312).

## Context

Per-instance isolated provider homes (06 §9.1) keep the user's own skills, subagents, instructions, commands and settings out of every Hercule session. The memory-interface prototype (#31) proved that right for assistant sessions - the user's material distorted them - and workflow agent steps must behave identically on every runner, so absorbing whatever `~/.claude` sits on the placement machine would break reproducibility. But the Thread is sold as the t3-code experience, and t3-code loads the user's config wholesale (it never touches `settingSources`; the SDK default pulls user, project and local). Hercule raised that expectation and then withheld the user's stored knowledge.

Three shapes were on the table: (1) live links from the user's own directories into the instance home, (2) a one-time snapshot import at login, (3) Hercule-owned knowledge as controller state, materialized fleet-wide. And within shape (1), a trimmed cut - knowledge only, no hooks or permission rules - was considered and rejected: the user's stated model is that a Thread is "exactly like using claude code except with different UI sauce".

## Decision

**Threads, and only Threads, see the user's own material - linked live, wholesale, per installation.**

- The source is a per-(instance × runner) `userMaterialDir` naming a local installation (Claude: a config dir; Codex: a `CODEX_HOME`; pi: an agent dir). It is a runner-scoped opaque path, never instance config (the no-paths rule stands). On the local runner it is auto-set when first-run detection recognizes the installation - the goodies come with the provider, no explicit opt-in; a manually added instance (a second, work installation) makes the choice at creation, assumed yes. Multiple local installations map to multiple provider instances, exactly like multiple logins.
- Links, not copies: the runner symlinks the material directories into the instance home at provision, so the material is always current and a skill added tomorrow appears in the next Thread. Directory-level links make the user's own inner symlinks resolve; Claude documents symlinked skills as supported and deduplicated.
- Wholesale means hooks, permission rules, env and model defaults ride in on Claude via `settings.json`. Two consequences are accepted with eyes open: the user's hooks and allow-rules can auto-approve tools beneath an `approval-required` Thread profile, and a session can write through the links into the real `~/.claude`. That is the same trust the user extends to the harness itself; no half-sandbox.
- The carve-outs are mechanical, not taste: login-carrying files never link (Claude `.claude.json`, Codex `config.toml` - which Codex also writes trust state into), so user-scoped MCP servers are a stated v1 gap; pi extensions stay off because they share a process with Hercule's own approval extension and could fight the approval loop.
- Where the material dir does not exist on the placement runner, the Thread runs plain and the composer says so on the instance group row. No spawn failure, no copying material across machines.

Shape (3) - Hercule-owned knowledge per Agent, materialized fleet-wide - is the named post-v1 destination for agent knowledge, on the out-of-scope list as strongly wanted.

## Consequences

- Provider instance selection at thread start now decides three things at once: which account absorbs the usage, which login runs, and which skills/instructions the agent has. The instance therefore locks at start (14 §App shell); "model stays live" means model-within-instance.
- Isolation remains the default for every other session kind, and the Thread linking machinery is a separate runner module invoked only for Threads - isolated-session provisioning never imports it, so cross-pollution is a build error, not a runtime surprise.
- Assistants and workflow steps stay reproducible and undistorted; if a step needs knowledge, that is shape-(3) work, not a link.
- If Hercule-owned knowledge management (shape 3) becomes good enough, even the Thread link may be retired in its favor - on the record from the deciding session.
