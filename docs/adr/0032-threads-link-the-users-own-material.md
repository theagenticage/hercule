# 32. Threads link the user's own material, live and wholesale

Date: 2026-09-02

## Status

Accepted. Decided by [User knowledge in Hercule sessions](https://github.com/theagenticage/hercule/issues/52). Refines [ADR 0030](./0030-sessions-copy-their-configuration-and-a-thread-has-no-agent.md) (the Thread is where the exception lives) and the isolation rule of 06 §9.1; leaves [ADR 0028](./0028-provider-harnesses-are-runner-installed-executables.md) untouched.

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
