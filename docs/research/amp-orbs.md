# Amp orbs, and machines created on demand

Research for Rogier, 2026-11-25. Two questions:

1. Can Hercule offer Amp orbs as a kind of ephemeral machine, and feel Hercule-native while doing it?
2. What is the sandbox technology under self-hosted orbs (ate.dev), and could its ideas give Hercule better isolation and continuation in general?

Nothing was built, no cluster was touched, and no Amp command was run. Every fact about Amp comes from Amp's own pages, read on 2026-11-25. Each section separates **Verified** (a source says it) from **Inferred** (my reading). This repository is public, so nothing about the company's own deployment is written here; [section 7](#7-what-only-the-companys-own-deployment-can-answer) lists what only that deployment can answer.

## Decisions

| Date | Decision |
|---|---|
| 2026-11-26 | Rogier: the long-term goal is the cluster's compute (option B2). The short-term way there is Amp's agent (option C). |
| 2026-11-26 | Rogier: an orb thread may have fewer controls than a normal thread. Some of what Hercule offers in a thread may be turned off there, as long as it is said. |
| 2026-11-26 | Rogier: take the three-verb contract (spawn, pause, delete) for machines created on demand, on the condition that it works cleanly with the runners as they are. [Section 5.6](#56-does-the-contract-fit-the-runners-as-they-are) checks that condition against the code. |
| 2026-11-26 | Fact from Rogier: his controller is reachable only over Tailscale, so a machine in the work cluster cannot dial it today. A Tailscale integration for Hercule is being looked at in another thread and is not close. |

## 0. The short answer

- **An orb is not a machine Hercule can rent.** It is the working area of exactly one Amp thread. Amp's server creates it, pauses it and deletes it, and Amp's server also runs the agent: the model loop and the model calls happen at ampcode.com, and the orb only runs the agent's tools. What the company hosts is the hands, not the head.
- **So "orb as an ephemeral machine" works only with Amp's agent inside.** A Hercule thread can drive an Amp thread on the work cluster, and that can be made to look like a Hercule thread on a machine called "orb". Claude Code, Codex or pi cannot sensibly run in an orb as Hercule sessions.
- **The thing under the orbs can be an ephemeral machine for every Hercule harness.** The work cluster runs Agent Substrate (ate.dev), a sandbox runtime with snapshots. A Hercule runner can live in such a sandbox. That is a separate build that does not involve Amp at all.
- **Two corrections to the starting description.** In Amp's Kubernetes chart, orbs are gVisor sandboxes, not hardware virtual machines, and a pause saves files only, not memory. Both are from Amp's own docs ([section 4](#4-the-isolation-side-angle)).
- **Hercule has no "ephemeral machine" concept today.** The spec uses "ephemeral" only for workspaces. This research starts that design from nothing ([section 2](#2-what-hercule-has-today)).

What I would build first: **an Amp harness whose work runs in an orb** (option C below), because it is the only option that actually uses the orbs the company hosts, and it needs no new machine concept. The general ephemeral machine (option B2) is the better long-term investment and should be decided on its own merits, not as part of Amp support.

## 1. What an Amp orb is

### 1.1 The words

**Verified**

- An orb: "Orbs are cloud sandboxes where Amp agents work without using your computer. Every orb thread gets a fresh, isolated environment with your code, plugins, development tools, and the context of the thread that created it." ([docs/orbs](https://ampcode.com/docs/orbs))
- One orb per thread: "An orb is a machine that Amp creates for a thread." Its id is `amp-<thread id>`. ([docs/cli/runners](https://ampcode.com/docs/markdown/cli/runners), [docs/orbs/self-hosted](https://ampcode.com/docs/markdown/orbs/self-hosted))
- A runner is a different thing in Amp: "A runner runs on a machine you already have." "Amp does not create, size, pause, or wake the machine." ([docs/cli/runners](https://ampcode.com/docs/markdown/cli/runners))
- What a company hosts is a **self-hosted orb provider**: a program that creates, pauses and deletes orbs when Amp asks. Orbs launched 2026-06-30, self-hosted orbs 2026-10-22, on every plan. ([news/agents-in-orbs](https://ampcode.com/news/agents-in-orbs), [news/self-hosted-orbs](https://ampcode.com/news/self-hosted-orbs))

So "amp orbs (runners)" mixes two of Amp's terms. Amp's *runner* is the nearest thing to a Hercule runner. Amp's *orb* is a machine made for one thread and thrown away after.

### 1.2 Who runs what

**Verified**

- "Amp runs the agent loop and model inference on its own servers. Your orb runs the agent's tools, such as reading and editing files and running commands." ([docs/orbs/self-hosted](https://ampcode.com/docs/markdown/orbs/self-hosted), "What Leaves Your Network")
- Goes to Amp and is stored with the thread: "the file contents the agent reads, command output, the diff shown in the thread's Changes tab", plus screenshots and attached files.
- Stays on the company's infrastructure: "The repository checkout, build output, and saved orb disks stay on your infrastructure."
- Amp's server cannot be self-hosted: "Amp doesn't offer self-hosted deployments." ([security](https://ampcode.com/security))
- "Only outbound HTTPS is needed; Amp never connects in." ([docs/orbs/self-hosted/kubernetes](https://ampcode.com/docs/markdown/orbs/self-hosted/kubernetes))

```
                 ampcode.com (Amp's servers, not self-hostable)
        ┌──────────────────────────────────────────────────────────┐
        │ thread store · agent loop · model calls · scheduling     │
        │ model credentials (Model Routing) · GitHub token minting │
        └───────▲──────────────────────────▲───────────────────────┘
                │ claims jobs              │ tool calls and results
                │ (spawn, pause, delete)   │ (outbound WebSocket)
   ─ ─ ─ ─ ─ ─ ─│─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │─ ─ ─ ─  company cluster ─ ─
        ┌───────┴──────────┐      ┌────────┴───────────────────────┐
        │ amp-orb-provider │      │ orb  amp-T-123  (gVisor sandbox) │
        │ pod              │─────▶│ `amp orb bootstrap`              │
        │ `amp orb provider`│ asks │ checkout at ~/workspace/repo     │
        │ + dispatch       │ Sub- │ bash, git, docker, node, ...     │
        └──────────────────┘ strate└────────────────────────────────┘
```

**Inferred**

- The local Amp CLI works the same way. The security page says the client "communicates with and executes tools as requested by Amp Server" and sends results back "for the next step in the agentic loop". The CLI pages do not say it in those words. So with Amp there is no way to run the agent loop yourself, on an orb or anywhere else.

### 1.3 The details asked for

| Question | Answer | Source |
|---|---|---|
| What runs in the pod | Amp's image `amp-orb` (Debian 12 or 13 with git, gh, Node, Bun, Python, Docker Engine, Chrome and more). The dispatch program starts `amp orb bootstrap`, which "connects out to Amp so Amp can set up the environment and run the agent's tools." A custom image is allowed (`ORB_IMAGE`). | [docs/orbs/self-hosted](https://ampcode.com/docs/markdown/orbs/self-hosted), [docs/orbs/customizing](https://ampcode.com/docs/orbs/customizing) |
| What it talks to | `ampcode.com` over HTTPS and WebSocket, `tunnel.ampcode.com` for the terminal and desktop views, and the Git host. | [docs/orbs/self-hosted/kubernetes](https://ampcode.com/docs/markdown/orbs/self-hosted/kubernetes) |
| Who schedules | Amp's server. "When a member creates a thread on your provider, Amp sends a `spawn` job. When the thread goes idle or is archived, Amp sends `pause`." | [docs/orbs/self-hosted](https://ampcode.com/docs/markdown/orbs/self-hosted) |
| The provider contract | `amp orb provider ./dispatch.sh`. The program is called with `ORB_OPERATION` = `spawn`, `pause` or `delete`, and `ORB_ID`, `ORB_IMAGE`, `ORB_SNAPSHOT_ID`, `ORB_TYPE`, `ORB_TOKEN`, `AMP_URL`. One provider process per token (`aop_live_…`). | same |
| Model credentials | Never in the orb. "Amp sends model requests from its own servers." Own API keys and subscriptions (ChatGPT, Claude, Copilot, Grok) are linked in Amp's Model Routing. "Amp does not copy API keys or subscriptions from Model Routing into the orb." | [docs/customize/model-routing](https://ampcode.com/docs/customize/model-routing) |
| A Claude subscription | "It runs through the Claude Agent SDK on Amp's servers, so nothing needs to be installed in your orb or on your runner." | [docs/model-selector](https://ampcode.com/docs/markdown/model-selector) |
| Git credentials | "Amp does not place a long-lived token in the orb." A credential helper asks Amp for a short-lived token of the member who created the thread. | [docs/integrations/github](https://ampcode.com/docs/integrations/github) |
| Other secrets | Workspace, project and personal values are written to `~/.env` (mode 0600) when the orb starts. | [docs/orbs/handling-secrets](https://ampcode.com/docs/orbs/handling-secrets) |
| The repository | "Amp clones the project's repository into each new orb", at `/home/user/workspace/repo`. | [docs/orbs/customizing](https://ampcode.com/docs/orbs/customizing) |
| Setup | Two scripts in the repository: `.agents/setup` installs dependencies, and its result is saved as a project snapshot that new orbs start from; `.agents/resume` runs after every wake. | same |
| State the orb keeps | Its disk. The thread itself lives on Amp's server ("Amp Server stores these conversations in its PostgreSQL database"). | [security](https://ampcode.com/security) |
| Pause | "an orb pauses 5 minutes after the agent finishes or 20 minutes after your last interaction, whichever comes later." | [docs/orbs](https://ampcode.com/docs/orbs) |
| What a pause keeps, Kubernetes chart | Files only: "The bucket holds the orb's files, not its memory, so processes in the orb stop when it pauses." About 1 to 2 GiB per paused orb. | [docs/orbs/self-hosted](https://ampcode.com/docs/markdown/orbs/self-hosted) |
| Resume | The next message makes Amp send `spawn` again with the same `ORB_ID`; the disk is restored and `.agents/resume` runs. | same |
| Deletion | Self-hosted: only when Idle Orb Cleanup is on (3 to 30 days). After a deletion only Git changes are restored into the next orb. | same |
| Delivery | The Ship button sends a prompt: commit, rebase, test, push. "Push to Branch" pushes a feature branch and reports a pull request URL. | [docs/orbs/shipping](https://ampcode.com/docs/orbs/shipping) |
| Price | Self-hosted orbs are "free on the Hobby, Individual, and Teams plans. Enterprise workspaces pay 100% of the standard Amp-hosted orb price for the orb's CPUs and memory." | [docs/orbs/sizes-and-costs](https://ampcode.com/docs/orbs/sizes-and-costs) |

### 1.4 How a program drives Amp

**Verified**

- **One turn, locally:** `amp -x "prompt" --stream-json` prints one JSON object per line: `system` (`init`, `subagent_finished`, errors), `assistant`, `user`, `result`. Tool calls, tool results and token usage per message are in it. Thinking only with `--stream-json-thinking`. The format "tries to be compatible with Claude Code's format as much as possible." ([docs/cli/streaming-json](https://ampcode.com/docs/markdown/cli/streaming-json))
- **Many turns, locally:** `--stream-json-input` reads user messages from stdin, and a message with `steer: true` is handled "at the next interruption point while the agent is busy."
- **In an orb:** `amp -ox "prompt" --orb-provider our-k8s-orbs --project owner/repo --stream-json`. `-ox` is short for `--orb-execute -x`. "The output format is identical to local `amp -x --stream-json`." The local process only streams. ([docs/cli/spawning-orbs](https://ampcode.com/docs/markdown/cli/spawning-orbs))
- **A follow-up in an orb:** `amp threads continue T-… -ox "message"`. `--mode`, `--project`, `--orb-size` and `--orb-provider` are ignored when continuing.
- **No steering in an orb:** "`--stream-json-input` is not supported with `-ox`; send a single prompt instead."
- **REST:** `POST /api/v2/threads` with `project`, `message`, and optional `agentMode`, `title`, `labels`. The body has no field for the orb provider or the executor. Follow-ups are `POST /api/v2/threads/{id}/messages`, then poll until the agent state is `idle`. ([openapi](https://ampcode.com/api/v2/openapi.json))
- **SDKs:** `@ampcode/sdk` (npm) and `amp-sdk` (PyPI) wrap the CLI.
- **Sign-in without a browser:** `AMP_API_KEY` holding an `sgamp_` access token. Service account keys exist since 2026-11-03.
- **Cost:** not in the stream. USD per thread comes from `GET /api/v2/threads/{id}/usage`, which needs a workspace API application.
- **ACP:** Amp does not speak the Agent Client Protocol. The registry's `amp-acp` is one person's wrapper ([tao12345666333/amp-acp](https://github.com/tao12345666333/amp-acp), Apache-2.0, v0.13.0 of 2026-11-15) around the same `--stream-json` interface, with an `--orb-execute` option.

**Not found, needs a test run**

- How approvals work without a terminal. The stream has `permission_denials`, and the REST agent state has `awaiting_approval` ("the agent waits for a person to approve a tool call"), but no page describes answering an approval from a program.
- Whether a thread started over REST or the SDK lands on the self-hosted provider. Only the CLI flag picks a provider. My guess is the project's Default Orb.
- What an orb thread's stream shows while the orb is created, set up or woken.

### 1.5 Where an orb overlaps with Hercule

| Amp | Nearest in Hercule | How they differ |
|---|---|---|
| Amp's server | The controller, plus the harness's agent loop, plus the Provider | Hercule runs the agent loop on the runner, inside the harness. Amp runs it centrally. |
| Thread (`T-…`) | Session, Thread | Amp keeps the transcript on its server. Hercule keeps a normalized stream on the controller and the harness's own files on the runner's disk. |
| Orb | An ephemeral Workspace, plus a machine around it | Hercule has the workspace but not the machine: a workspace is a folder on a runner that many sessions share. |
| `amp orb bootstrap` in the orb | The runner | Both dial out and accept no connection. The orb's process only runs tools. A Hercule runner runs the whole harness and holds its home. |
| Orb provider (`spawn`, `pause`, `delete`) | Nothing | A Hercule runner is joined by hand, once, and stays. This is the missing concept. |
| Amp runner (`amp --no-tui`) | The runner | The closest match. |
| Pause and wake | A session that is `exited` and resumable, resumed in place by the next input | The same idea. Hercule already resumes under the same session id (spec 06 §4.1). |
| Project snapshot after `.agents/setup` | The setup command of a new workspace | Hercule runs setup again for every new workspace. Amp runs it once and copies the result. |
| Model Routing connections | Provider Accounts | Amp holds the credential and calls the model itself. Hercule hands the credential to the harness on the runner. |
| Short-lived Git token from a helper | Git credentials derived from a Connection (ADR 0016) | The same idea. |
| `.agents/setup` in the repository | Setup command in controller state | Hercule's rule is "no repo-local Hercule config". Amp's scripts live in the repository. |

The overlap is real, but it is at the level of the two whole systems. The orb alone overlaps with very little of a Hercule runner.

## 2. What Hercule has today

**Verified, from the spec and the ADRs**

- **No ephemeral machine exists.** "Ephemeral" appears only as a workspace kind (GLOSSARY "Workspace", spec 03 §6.3). No issue, ADR or open item mentions cloud runners, Kubernetes or machines created on demand. `docs/spec/16-open-items.md` has nothing on it.
- **A runner is a durable member of the Fleet.** A person runs `hercule runner join` once; the runner keeps a credential and a storage directory (spec 03 §3). The join "is fully programmatic: no interactive prompts, so a future auto-installer can drive it end to end."
- **Work is pinned where it lands.** "A Workspace is pinned to the runner it was provisioned on. A Session is pinned to the runner it started on: harness session state lives on that disk." (spec 03 §5.2). "No load balancing, no migration, no failover" (ADR 0002).
- **A runner that goes away cleanly is `offline`**: "announced shutdown: outbox flushed, sessions cleanly interrupted and resumable", and its placements "wait for return" (spec 03 §7). `retired` is final.
- **Sessions are bare processes** under the runner's OS user (ADR 0003). The spec says what that costs: "Agent/user credential separation defends against accident and drift, not against a malicious process on the same machine. Real isolation (OS sandboxing, containers) is post-v1." (spec 13)
- **Post-v1 list** (spec 03): native OS sandboxing "and containers as a remoter option", "Load balancing, session migration and failover between runners", "Hercule-managed toolchains and an Environment concept". All three are touched by this research.
- **Accounts that work on any runner already exist.** An API key and the Claude subscription token are held by the controller and sent with each frame; "Claude's `/login` and Codex's ChatGPT login stay per machine" (ADR 0048).
- **A harness is a plugin plus an adapter.** The plugin declares the harness and what it runs; the runner's adapter starts the process and turns its output into the normalized event stream (spec 06 §1, §4).
- **A session may have no workspace** (`workspaceId: null`): it runs in an empty scratch folder (spec 03 §6.1).

## 3. The ways Hercule could use orbs

From thinnest to deepest. B is split in two, because "an orb as a place where a Hercule runner runs" has two readings with opposite verdicts.

### A. Amp as a harness on an ordinary runner

Amp's CLI runs on a Hercule runner, in a Hercule workspace, like Claude Code does. No orb is involved.

- **What the user sees.** A thread whose model menu has an "Amp" section. Machine, workspace, branch and diff are Hercule's as usual.
- **Hercule-native.** Machine choice, workspace and checkout, Git credentials from the Connection, the transcript, steering (`steer: true`), the `hercule` CLI in the session, MCP through the gateway (`--mcp-config`), Task and stage.
- **Not Hercule-native.**
  - The agent loop and the transcript live at Amp. The thread is also visible on ampcode.com.
  - Models and their bill are Amp's: Amp credits, or what is linked in Amp's Model Routing. Hercule's Provider Accounts for Anthropic and OpenAI play no part.
  - Skills and instructions are Amp's own (`.agents/`, Amp plugins), not the Skill Library.
- **What Hercule adds.**
  - A provider plugin `amp` with one key Account Kind (an `sgamp_` token as `AMP_API_KEY`). It works on every runner, like any key account.
  - A harness plugin `amp` and a runner adapter: start `amp -x --stream-json --stream-json-input`, map the stream to the normalized events, store `T-…` as the native session id, resume with `amp threads continue`.
- **What breaks or is unknown.**
  - Approvals: unknown how a program answers one ([1.4](#14-how-a-program-drives-amp)). Until tested, only `full-access` can be promised, and the Access Mode fallback only moves to less permissive modes, so a thread asking for `approval-required` would have to be refused with a message, not downgraded.
  - Resume is unusually easy: the transcript is at Amp, so a session is not tied to its runner's disk for its history. Its workspace still is.
- **The ACP route.** `amp-acp` plus Hercule's coming `packages/acp` would work, but it puts one volunteer's wrapper between Hercule and the same `--stream-json` lines. I would read the stream directly. `amp-acp` is useful as a reference for the mapping.

### B1. A Hercule runner inside an Amp orb

A custom orb image holds the `hercule` binary; a script in the orb joins the controller as a runner. An Amp thread exists only to make Amp create the machine.

- **Verdict: possible in principle, do not build it.**
- **Why.**
  - Amp owns the machine's life. It pauses the orb 5 minutes after *its* agent finishes or 20 minutes after the last human action *in Amp*. Work a Hercule session does in the orb does not count, so the orb would be paused under a running session, and a pause on the Kubernetes chart kills every process.
  - Keeping it awake means keeping an Amp agent busy on purpose, which pays Amp inference for nothing and, on an Enterprise plan, orb minutes.
  - Every Hercule thread would need an Amp thread as a carrier, and Amp paces new orbs ("a burst of 20 metered orbs", then "one new orb every five minutes").
  - It uses Amp as a virtual machine vendor, which is not what its terms describe.

### B2. A Hercule runner in a sandbox of its own, on the same runtime

Hercule does for itself what `amp orb provider` does for Amp: it asks the sandbox runtime in the cluster for a machine, and the machine runs `hercule runner`. Amp is not involved. This is the general "ephemeral machine", described in [section 5](#5-a-general-concept-machines-created-on-demand).

- **What the user sees.** A machine choice like "Work cluster" in the composer. The thread behaves like any thread: Claude Code, Codex or pi, Hercule's workspace, branch, diff, approvals, skills.
- **Hercule-native.** Everything, because the runner inside is an ordinary runner.
- **Not Hercule-native.** Nothing in the thread. New is how the machine comes and goes.
- **What Hercule adds.** A way to create, pause and delete machines, a machine image, and the rule that wakes a paused machine when its thread gets input.
- **What breaks.**
  - Per-machine sign-ins (Claude `/login`, the ChatGPT login of Codex) do not work on a machine that did not exist a minute ago. Key and token accounts do.
  - The controller must be reachable from the cluster. Amp's chart lets a sandbox open TLS to any host and refuses everything else, so a controller behind a tailnet address is a problem, and one behind a public TLS address is not.
  - Whether the company's cluster may host a second tenant beside Amp is a question for the people who run it. Amp's docs ask for "a dedicated cluster".

### C. An Amp thread in an orb, driven from a Hercule thread

The Amp harness of option A, with one difference: the work runs in an orb, not on the Hercule runner. The runner only starts the CLI and reads the stream.

- **What the user sees.** A Hercule thread. Model menu: Amp. Where it runs: "Orb · <provider name>", not one of the Fleet's machines. The transcript fills as in any thread. There is no Hercule workspace: no branch picker, no diff from Hercule. The result arrives as a branch or a pull request on GitHub.
- **Hercule-native.** The thread, its Task and stage, the transcript, Token Usage, queued follow-ups, and the pull request as an External Entity through the GitHub Connection.
- **Not Hercule-native.**
  - Everything listed under A.
  - The workspace is Amp's. Hercule cannot show its files or its diff, run a Workspace Action in it, or watch edits for Edit Overlap.
  - No steering inside a turn (`--stream-json-input` is refused with `-ox`). A follow-up waits for the turn to end.
  - The `hercule` CLI is not in the orb, so the agent cannot use Discussions, the Wiki, or spawn sessions, unless the image carries the binary and the session's token reaches the orb. Each needs its own answer.
  - MCP servers must be set on the Amp project; the gateway is not reachable by a local flag.
  - Git runs as the Amp member, with Amp's GitHub integration, not Hercule's Connection.
  - The pull request is not linked to the Task by itself. Hercule finds a Thread's pull request by joining the pull request's head branch with the branch of the Thread's checkout (spec 20 §14.4), and here Hercule has no checkout. The user links it by hand, or the adapter has to report the orb's branch some other way.
- **What Hercule adds.**
  - The provider plugin and harness plugin of A.
  - In the adapter, a second way to run: one `amp -ox … --stream-json` process per turn, and `amp threads continue T-… -ox` for each later turn. The session has no workspace (`workspaceId: null`), which exists today.
  - A place to say which orb provider and which Amp project a thread uses. The Amp project can be found from the Resource's remote, because `--project` accepts a repository URL.
- **What breaks.**
  - "A session has a turn running while its process runs" stops being true between turns: there is no process, and the orb may be paused. The adapter has to report the session as idle with nothing running, which the spec allows ("spawns or attaches").
  - Access Mode: as in A.
  - Timeouts and cost: Amp decides when the orb pauses. Hercule can only show it.

### Comparison

| | A. Amp harness, local | B1. Runner in an orb | B2. Runner in own sandbox | C. Amp harness, orb |
|---|---|---|---|---|
| Uses the company's orbs | no | yes, badly | no (same cluster, own machines) | **yes** |
| Works with Claude Code, Codex, pi | no | yes | **yes** | no |
| Hercule workspace, diff, approvals | yes | yes | **yes** | no |
| Transcript stays off Amp's servers | no | yes | **yes** | no |
| New concept in Hercule | provider + harness | none, a hack | machines on demand | provider + harness |
| Size | medium | small, fragile | large | medium |
| Needs the cluster's owners | no | no | yes | no |

### What I would build first: C, on the foundation of A

- C is the only option that does what was asked: use the orbs the company hosts, from Hercule.
- A and C are one harness with two ways to run. The plugin, the account kind and the event mapping are shared. C's adapter is the simpler of the two (one process per turn, no steering).
- It needs no new machine concept, so it does not prejudge section 5.
- Before building, one live command settles the unknowns ([section 8](#8-live-checks-rogier-could-run)).

**One thread's life in C**, as an example. The provider name `work-orbs` and the repository `acme/webshop` are made up.

1. Rogier adds a Provider Account "Amp" by pasting an Amp access token. The controller keeps it as a Secret.
2. In the project of the repository he starts a thread: "Find out why the nightly export is slow." Model: Amp. Runs in: Orb · `work-orbs`.
3. The controller starts a session with no workspace on his local runner. The adapter runs
   `amp -ox "Find out why…" --orb-provider work-orbs --project acme/webshop --stream-json` with `AMP_API_KEY` set.
4. Amp sends `spawn` to the provider pod in the work cluster. A sandbox starts from the project snapshot, with the repository cloned. Amp's server runs the model loop and sends tool calls into the sandbox.
5. Stream lines arrive at the CLI on Rogier's runner. The adapter maps them: `system/init` gives `T-abc`, stored as the native session id; `assistant` lines become messages and tool items; `result` ends the turn with its token count. The process exits. The thread shows idle.
6. Six minutes later Amp pauses the orb: files go to the bucket, processes stop. Hercule shows nothing new, because nothing changed for the thread.
7. Next morning Rogier types "Open a pull request with the fix." The adapter runs `amp threads continue T-abc -ox "Open a pull request…" --stream-json`. Amp sends `spawn` with the same orb id, the files come back, `.agents/resume` runs, the agent pushes a branch and reports the URL.
8. Hercule's GitHub Connection sees the pull request as an External Entity. Rogier links it to the thread's Task by hand, because Hercule has no checkout whose branch it could match (spec 20 §14.4).
9. Rogier's laptop is replaced a week later. The thread still continues from any runner, because its history is at Amp and its files are in the cluster. Nothing of it lived on the laptop.

## 4. The isolation side angle

### 4.1 What ate.dev is

**Verified**

- ate.dev is the site of **Agent Substrate**: "A secure-by-default runtime for running agents at scale." `ate` was "originally *Agent Task / Execution Engine*" and is the prefix of its namespaces, binaries and its Kubernetes API group `ate.dev/v1`. ([ate.dev](https://ate.dev), [llms-full.txt](https://ate.dev/llms-full.txt))
- Created by Google, announced 2026-05-21, Apache-2.0, version 1.0.0 on 2026-11-05, donated to the CNCF as a sandbox project the same day. Its README still says "the project is VERY young." ([Google Cloud blog](https://cloud.google.com/blog/products/containers-kubernetes/bringing-you-agent-sandbox-on-gke-and-agent-substrate), [Google open source blog](https://opensource.googleblog.com/2026/11/sandboxing-untrusted-ai-agents-at-scale.html), [repository](https://github.com/agent-substrate/substrate))
- The link to Amp: "Orbs run as gVisor sandboxes on Substrate, an open source sandbox runtime for Kubernetes that the chart installs with the provider." Amp keeps a fork, [ampcode/substrate](https://github.com/ampcode/substrate), with support for EKS, AKS and Azure storage.
- Amp-hosted orbs do not use it: "e2b provides ephemeral compute instances for Amp orbs." ([security](https://ampcode.com/security))

### 4.2 What it gives

| | Substrate, as designed | Amp's Kubernetes chart |
|---|---|---|
| Sandbox | gVisor (a kernel in user space, the default) or a Cloud Hypervisor microVM under Kata. "Plain Linux containers are unsupported." | gVisor only, loosened: sandboxes run as root "with `--allow-suid` and `--net-raw`" so Docker works inside. |
| Node needs | gVisor: a standard Linux node. MicroVM: `/dev/kvm`, x86, nested virtualization or bare metal. | Worker nodes with a 500 GB disk; default orb type 16 vCPU and 32 GiB. |
| Network | Default deny. An egress gateway "enforces destination host allowlists". | TLS to any host on any port, plain HTTP on four ports, everything else refused. |
| Credentials | A gateway can add a secret header on the way out: "The actor never holds the secret." | No sign that the chart uses this. The orb gets its secrets in `~/.env`. |
| Snapshot | Three levels: `VOLUMES` (chosen folders), `ROOTFS` (the whole disk, processes start cold), `MEMORY` (disk plus "the running process tree and RAM state", the default). | Files only. |
| Resume | "resume in under 500ms on any ready worker", possibly on another node. A memory restore needs the same runtime version, or it "falls back to `ROOTFS` and cold-boots". | New orb on a warm worker: "Seconds." Pause: "A few seconds to a few minutes". |
| Where snapshots live | Object storage (GCS or S3), after a local copy. | The company's bucket, 1 to 2 GiB per paused orb. |
| Fork | A tag holds a copy of a snapshot; a new sandbox can start from a tag. | Project snapshots: a prepared orb reused for at most 72 hours. |
| Who pauses | Not built in: "Whatever drives the actor, usually its harness, has to call `SuspendActor`". Waking on an incoming request is built in. | Amp's server, by its idle rule. |
| Driving a process inside | No exec call. You bring your own program in the sandbox that dials out or serves HTTP. | `amp orb bootstrap` dials out to Amp. |
| Cost | Open source. A paused sandbox holds no worker; a warm worker holds memory on a node. Needs Kubernetes 1.37 or later, PostgreSQL, object storage, a router and an egress gateway. | Free on most plans, per CPU and GiB on Enterprise. |

Sources: [ate.dev/llms.txt](https://ate.dev/llms.txt), [ate.dev/llms-full.txt](https://ate.dev/llms-full.txt), [GKE page](https://docs.cloud.google.com/kubernetes-engine/ai-ml/about-agent-substrate), Amp's [self-hosted](https://ampcode.com/docs/markdown/orbs/self-hosted) pages and install bundle.

**Two corrections to the starting description**

- "Virtualization" is not what the company runs. Amp's chart uses the gVisor class. gVisor is a strong boundary (the sandbox never talks to the host kernel directly), but it is not a virtual machine, and Amp's fork relaxes it.
- "Continuation" in the chart means files, not processes. The stronger kind (stop today, resume next week with the dev server still running) exists in Substrate and on Amp-hosted orbs, not in the chart.

**Still open in Substrate by its own status table**: per-sandbox snapshot encryption ("Future"), a delete guarantee between runs ("In Progress"), quotas ("Future"). And: "There is no meaningful security boundary inside an actor."

### 4.3 Compared with Hercule today

| | Hercule today | A machine per thread in a sandbox |
|---|---|---|
| What an agent can reach | Everything the runner's OS user can: other threads' workspaces, the Harness Homes, the user's files on a laptop. | Only its own machine: its checkout, its harness home, the credentials sent for its own session. |
| Network | The machine's network. | Whatever the egress gateway allows. |
| A dev server left running | Lives until the session's process is unloaded, which is why a Thread has no idle timeout (spec 03 §6.2). | With files-only pause: dies at pause, restarted by a script. With memory pause: survives. |
| When the machine is lost | "its sessions' resumability dies with it" (spec 06 §4.1). | The snapshot is in a bucket; another node resumes it. |
| Setup cost of a new workspace | The setup command runs every time. | Run once, snapshot, start every new machine from the snapshot. |
| On a Mac | Native: the machine's own toolchains and Keychain (the reason ADR 0003 gives against containers). | Not available. Substrate needs Linux nodes. Apple's `container` tool gives Linux machines with files-only snapshots. |

ADR 0003 rejected a container *per session on the runner*: generated Dockerfiles, credentials copied into sandboxes, Docker replacing the Mac's own tools. A runner *inside* a sandbox is a different design and keeps what ADR 0003 decided: sessions are still bare processes started by a runner, and the runner's code does not change. The sandbox is around the machine, not around the session. I see no contradiction with ADR 0003. It does add a machine image as a new artifact, which ADR 0018 ("no Docker image … in v1") did not plan for.

## 5. A general concept: machines created on demand

A sketch, to show what the idea would look like in Hercule's terms. Not a design.

**Naming first.** "Provider" already means the company that serves models (ADR 0048), so Amp's word "orb provider" cannot be reused. "Ephemeral" already names a workspace kind. I use the working names **machine pool** (a place that can create machines) and **on-demand machine**; the glossary would have to settle them.

### 5.1 The shape

```
 controller                         pool runner (durable,                 on-demand machine
 (brain, unchanged)                 in the cluster)                       (sandbox)
      │                                   │                                      │
      │ 1. spawn machine M  ─────────────▶│ dispatch: create sandbox from image, │
      │    (join token, controller URL)   │ pass the token ─────────────────────▶│ `hercule runner join`
      │◀───────────────────────────────── 2. runner dials out, hello ────────────│
      │ 3. provision workspace, start session (today's frames, unchanged) ──────▶│
      │                                   │                                      │
      │   … thread idle for N minutes …   │                                      │
      │ 4. pause machine M ──────────────▶│ dispatch: snapshot, free the worker  │ (gone; disk in bucket)
      │                                   │                                      │
      │   user sends input                │                                      │
      │ 5. spawn machine M again ────────▶│ dispatch: restore ──────────────────▶│ same runner, same disk
      │◀───────────────────────────────── runner reconnects; session resumed in place
      │                                   │                                      │
      │   thread archived                 │                                      │
      │ 6. delete machine M ─────────────▶│ dispatch: delete sandbox and snapshot
```

- **Three verbs: spawn, pause, delete**, with a stable machine id. This is Amp's provider contract, and it is the right size: the pool is dumb, the controller stays the only brain (ADR 0002).
- **The pool runner** is an ordinary, durable Hercule runner in the cluster that also knows the three verbs, advertised as a capability at hello (spec 03 §2.2 calls the capability list "the protocol's extensibility seam"). It exists because the controller cannot reach into the cluster, exactly as Amp's provider pod exists because Amp "never connects in".
- **The machine holds an ordinary runner.** Its Hercule Home is on the saved disk, so its credential, workspaces and Harness Homes come back with it.
- **Drivers behind the same three verbs** could be: Substrate in a cluster (files, or files and memory), Docker on a Linux box (files), Apple's `container` on a Mac (files), E2B (files and memory, hosted). Amp publishes dispatch examples for most of these, which shows the contract fits them.

### 5.2 Why it fits Hercule with little change

- **Pinning stays true.** A workspace and a session stay pinned to their runner. The runner's disk moves with the machine through pause and resume, so nothing has to migrate. "No migration" in ADR 0002 is untouched.
- **A paused machine is an `offline` runner with a way back.** Today "placements pinned to a runner that is `offline` … wait for its return." New is only that the controller can cause the return.
- **Resume in place already exists.** A session that is `exited` and resumable is resumed "under the same Hercule session id" by the next input. Files-only pause needs nothing more from the session model.
- **The join was built for this**: prompt-free and programmatic.
- **Accounts**: key and token accounts work on a machine that is seconds old, because the controller sends the secret with the frame.
- **Git**: credentials from the Connection are sent with the session, as today.

### 5.3 What would have to be decided

- **One machine per thread, or machines shared by threads.** Per thread gives the isolation and matches Amp. Shared machines are cheaper and give none between their threads.
- **Who pauses, and when.** Substrate does not do it by itself. The controller would pause a machine with no running turn and no open Request for some minutes.
- **The Fleet screen.** One pool as one row with its machines under it, or dozens of runners. Runner Metrics are kept per runner per minute (spec 03 §4.3).
- **The image.** It carries the `hercule` binary, the harnesses and the toolchains. That answers, for these machines, the question of [#587](https://github.com/theagenticage/hercule/issues/587) (installing software on runners without a shell). ADR 0028's "explicitly updated" harness versions become "the image tag".
- **Per-machine sign-ins.** A ChatGPT subscription in Codex cannot be used on such a machine today. Either accept that, or find Codex's equivalent of the Claude subscription token.
- **What reaches the machine.** The provider key is in the harness's environment, so the agent can read it. Substrate's header-adding gateway would keep keys out of the machine entirely. Amp gets the same result by never running the model call in the orb.
- **Reachability.** The machine must reach the controller over TLS.

### 5.4 Continuation, in two strengths

- **Inside one pool: comes free.** Pause on one node, resume on another. With memory snapshots even the processes survive.
- **Across pools or kinds of machine: snapshots do not help.** A gVisor checkpoint, a Firecracker memory file and a tar of a disk are not interchangeable. What travels everywhere is what Amp falls back on when an orb is deleted: "Git changes … are restored into the next orb", with the thread kept on the server.
  - For Hercule that means: the workspace travels as Git (the branch plus uncommitted changes), and the session travels as the harness's own session files.
  - *Inferred, needs a test:* a fixed image helps here. ADR 0048 notes that "Codex stores absolute transcript paths" and that Claude Code keys its login by "a hash of the config folder's path". Both are tied to paths, and inside one image every machine has the same paths. Moving a Harness Home between two machines of the same image may simply work where it cannot between two real machines.

### 5.5 Does this make orb support easier?

- **For Amp's orbs: no, only different.** Amp manages its own machines. Supporting orbs is a harness question (options A and C) whether or not Hercule has machine pools.
  - One small gain: if Hercule has "a thread on a machine made for it, currently paused" as a concept, an orb thread can be shown with the same words and the same screen, instead of as a thread with no machine.
- **For other ephemeral runners: yes, clearly.** With the three verbs and an ordinary runner inside, a new kind of machine is one dispatch program. No session, workspace or harness code changes.
- **Principles worth taking from Amp and Substrate, whatever is built:**
  1. Three verbs and a stable machine id; the brain stays central.
  2. The machine dials out; nothing connects in. Hercule already does this.
  3. Pause is the normal resting state, and the next input wakes the machine. Hercule already does this for sessions.
  4. Run setup once, snapshot it, start from the snapshot.
  5. Long-lived credentials stay out of the machine: short-lived Git tokens, model keys added at the edge.
  6. Default-deny network with an allowlist.

### 5.6 Does the contract fit the runners as they are?

Checked against the code on `main` at `571cae48c`. Short answer: **yes for the runner, which needs no change at all. Everything new is on the controller, plus one new capability on the pool runner.**

**What already works, unchanged**

| The contract needs | What the code does today | Where |
|---|---|---|
| A machine joins with no person present | The join is one request with a single-use token. The controller already starts a runner this way itself: its local runner writes `{"join": true}` on stdout and gets the token on stdin, so the token is never in the arguments or the environment. | `packages/protocol/src/index.ts` (`JoinRequest`, `LocalAnnouncement`, `LocalEnrolment`), `apps/controller/src/runners/join-tokens.ts` |
| Pause must leave sessions resumable | On SIGTERM the runner stops every session with reason `runner_restart`, waits up to 5 seconds for the harnesses, and sends `goodbye`. The controller then records the runner as `offline`, not `unreachable`. | `apps/runner/src/index.ts`, `apps/runner/src/sessions/supervisor.ts` (`SHUTDOWN_STOP_BOUND`), `apps/runner/src/socket.ts` |
| Input for a paused machine must wait, not fail | A resume is refused only when the runner is retired or draining, not when it is offline. A session whose runner is not connected goes back to `queued` with its input. | `apps/controller/src/daemon/sessions/resuming.ts`, `apps/controller/src/daemon/sessions/dispatch.ts` |
| Work must start by itself when the machine is back | "Everything that can give a runner room comes back through here: … or a new connection." A reconnect starts the queued sessions. | same file |
| The machine's identity must survive a pause | Credential, controller identity and storage folder are in `runner.json` and the runner's storage directory, both under Hercule Home. If the Home is on the saved disk, the same runner comes back. | `apps/runner/src/runner-file.ts` |
| An account must work on a machine that is seconds old | "A key or token account can run on a runner that was never probed". | `apps/controller/src/provider-accounts/account-runners.ts` |
| Delete must clean up the records | Retiring a runner ends its sessions and marks its workspaces lost, in one transaction. | `apps/controller/src/runners/service.ts` (`retire`), `apps/controller/src/daemon/runners/retirement.ts` |
| A paused machine must not raise alarms | Only an `unreachable` runner gets the "Runner … is unreachable" notification, and only sessions that are still `starting`, `idle` or `busy` on a runner that stays away are ended as lost. A clean pause leaves neither. | `apps/controller/src/runners/connections.ts`, `apps/controller/src/daemon/sessions/lost-runners.ts` |

So one pause and resume, seen from the runner, is a restart on the same disk. The runner cannot tell the difference, which is the property wanted.

**What is new, all on the controller side**

1. **A record of pools and of which runner is a pool's machine.** Today nothing says "this runner was made by that pool for this thread".
2. **The wake.** A session that becomes `queued` on a runner that is `offline` and belongs to a pool makes the controller ask the pool to spawn that machine. Today such a session only waits.
3. **The pause.** When a machine has no turn running and no open Request for some minutes, the controller asks the pool to pause it. Nothing decides this today, because a runner never goes away on the controller's initiative.
4. **The three verbs on the wire.** A capability a pool runner lists at hello, and frames for spawn, pause and delete with their results. The protocol has no frame today by which the controller tells a runner to do something to another machine.
5. **Placement.** One more step: "the target is a pool, so first get a machine". The rest of placement is unchanged, because after the join the machine is an ordinary runner that was named explicitly.

**What does not fit cleanly, and needs a decision**

- **Pause order.** The runner must have said goodbye before the snapshot is taken, or the controller sees silence, calls the runner `unreachable` and notifies the user. So "pause" in the dispatch program means: send SIGTERM to the runner, wait for it to exit, then snapshot. The contract has to say that, because a dispatch program that snapshots first would look like it works.
- **The Fleet fills up.** Each machine is a runner row with a name from the name list, a metrics history and a place in every runner menu. One machine per thread makes dozens. The screens need a rule, such as showing a pool as one row.
- **A retired runner stays forever.** "Nothing is deleted: the row and everything linked to it stay". Fine for a few machines a year, a lot for one per thread.
- **Every new machine is probed.** A facts report in which a harness appears makes the controller probe each account and harness pair there (spec 03 §4.2), and each probe starts a harness process. On a machine that lives for one thread that is cost with little use. Key and token accounts do not need it.
- **Every new machine clones from nothing.** A workspace is a worktree of a bare repository kept per Resource per runner (ADR 0039), and a new machine has none. For a large repository the first workspace is slow. This is what Amp's project snapshot solves, and why the contract carries a snapshot id on `spawn`.
- **A Thread's background processes.** A Thread has no idle timeout today, so that a dev server it started keeps running (spec 03 §6.2). Pausing the machine ends it. That is the same trade Amp makes, with `.agents/resume` to start services again; Hercule would need its own answer or would have to say plainly that a pause ends them.
- **Reaching the controller.** The machine dials the controller. With a controller that is only on a tailnet, the machine needs a way onto the tailnet first.

None of these touches the runner's code or the session model. They are controller rules and screens.

### 5.7 A path that respects all of this

1. **Now: option C**, the Amp harness with its work in an orb. It uses the orbs, needs no machine concept, and the CLI runs on a runner Rogier already has, so the controller's address does not matter. It starts as `full-access` only and without steering, and says so.
2. **Next: the contract with a driver at home.** A pool runner on a Linux machine that is already in the Fleet, with a dispatch program for Docker (spawn is `docker run`, pause is stop and `docker commit`, delete is `docker rm`). The machine is on the same network as the controller, so reachability is not in the way. This proves the five controller-side pieces and the pause order with nothing from Amp or the work cluster.
3. **Later: the work cluster as a second driver**, once a new machine can get onto the tailnet by itself. Only the dispatch program is new at that point.

Step 2 can be built before, after or beside step 1. They share no code.

## 6. Open questions for Rogier

1. **Is the goal the cluster's compute, or Amp's agent?** *Answered 2026-11-26: compute in the long term, Amp's agent as the short-term way there.*
   - Compute: "I want my Hercule threads, with Claude Code on my own subscription token, to run in the work cluster." Then orbs are the wrong door, and B2 is the build.
   - Amp's agent: "I want threads that colleagues can also open in Amp, run by Amp's agent." Then C is the build.
2. **May work code go through Amp's servers from a Hercule thread?** With A and C, what the agent reads and every command's output is stored at ampcode.com with the thread. The company already accepted that for Amp. With B2 nothing goes to Amp.
3. **Is your controller reachable from the work cluster over TLS?** *Answered 2026-11-26: no, it is on Tailscale only.* B2 needs it: a runner in the cluster dials the controller. A tailnet-only address is probably refused by the chart's egress rules. C does not need it: the CLI runs on a runner you already have.
4. **One machine per thread, or shared machines?** Per thread: every thread gets its own sandbox (Amp's default type is 16 vCPU and 32 GiB) and cannot touch another thread's files. Shared: one sandbox hosts eight threads, costs an eighth, and isolates the eight from the cluster but not from each other.
5. **Which accounts must work on on-demand machines?** Claude with the subscription token and any API key: fine today. Codex on a ChatGPT subscription: not without a sign-in inside each new machine.
6. **Are approvals needed in an orb thread?** *Answered 2026-11-26: no. An orb thread may have fewer controls, as long as it is said.* If "the orb is the sandbox, let it run" is acceptable, C can start as `full-access` only. If you want to approve commands from Hercule, that depends on a part of Amp I could not find documented.
7. **Who pays for orb minutes?** On Amp's Enterprise plan a self-hosted orb costs per CPU and GiB while it runs. Threads started from Hercule add to that bill like any other.
8. **Should an orb thread look like it runs on a machine?** Either "Orb · work-orbs" is a property of the thread, and the Fleet does not know it; or each orb provider appears in the Fleet as a kind of machine that is not a runner. The second reads better and changes what "Fleet" means.

## 7. What only the company's own deployment can answer

This repository is public, so what the company's repositories show is reported to Rogier directly and is not written here. These are the points that Amp's public pages cannot settle, and that decide details of options B2 and C:

- Whether the orbs are self-hosted with Amp's Helm chart as it is, with changed values, or with the company's own dispatch program; and on a cluster of their own or a shared one.
- The orb types (CPU, memory, how many are kept warm), the node architecture, and the image.
- Whether the Amp workspace is "Self-Hosted Only", which provider is the Default Orb, and the provider's name for `--orb-provider`.
- Whether Repository Setup is left to Amp or the image carries its own checkout and Git credentials.
- The plan (Enterprise pays per orb minute).
- Whether "Block Amp-Billed Inference" is on, and which model connections exist.
- Whether anything besides Amp may use the cluster's sandbox runtime, and what a sandbox there may reach on the network.

## 8. Live checks Rogier could run

Nothing here was run. Each costs a little Amp usage. `<provider>` and `<owner/repo>` are the company's own.

1. **Does a program get a usable stream from an orb thread?**
   `amp -ox "Reply with the word ok and nothing else." --orb-provider <provider> --project <owner/repo> --stream-json`
   - Expect: a first line `{"type":"system","subtype":"init",…}` carrying a thread id `T-…`, then `assistant`, then `result` with `subtype: "success"` and token usage.
   - Settles: whether orb creation and setup show up in the stream, and what the lines really contain.
2. **How does a wake look?** Wait ten minutes, then
   `amp threads continue T-… -ox "Print the working directory." --stream-json`
   - Expect: `/home/user/workspace/repo`, after the orb has woken.
   - Settles: wake time, and whether the stream says anything while waking.
3. **What does the cluster show meanwhile?** `kubectl get pods -n amp-orbs -o wide` and `kubectl get workerpools.ate.dev -A`
   - Expect: the `amp-orb-provider` pod, and worker pods on nodes labelled `ate.dev/sandboxClass=gvisor`.
   - Settles: the pool sizes and how many warm workers idle.
4. **Could a runner in the cluster reach the controller?** In an orb thread, ask the agent to run `curl -sS -o /dev/null -w '%{http_code}\n' https://<controller address>/`.
   - Expect: an HTTP status if reachable, a refused connection if not.
   - Settles: question 3 above.
5. **How do approvals behave without a terminal?** Run check 1 with a prompt that needs a command Amp would ask about, and watch for `permission_denials` in `result`.
   - Settles: whether C can offer more than `full-access`.

## Sources

Amp, read 2026-11-25:

- https://ampcode.com/docs/orbs and the markdown pages under https://ampcode.com/docs/markdown/ : `orbs/self-hosted`, `orbs/self-hosted/kubernetes`, `orbs/customizing`, `orbs/handling-secrets`, `orbs/shipping`, `orbs/sizes-and-costs`, `cli/runners`, `cli/spawning-orbs`, `cli/execute-mode`, `cli/streaming-json`, `sdk`, `customize/model-routing`, `model-selector`, `integrations/github`
- The self-hosted install bundle, https://ampcode.com/docs/orbs/self-hosted/bundle.zip (`self-hosted.md`, `changelog.md`, `gke.md`)
- https://ampcode.com/api/v2/openapi.json (read in part), https://ampcode.com/security, https://ampcode.com/terms, https://ampcode.com/terms/aup
- News: https://ampcode.com/news/agents-in-orbs, https://ampcode.com/news/self-hosted-orbs, https://ampcode.com/news/personal-self-hosted-orbs
- https://github.com/ampcode/substrate, https://github.com/tao12345666333/amp-acp, https://github.com/agentclientprotocol/registry

Agent Substrate and the alternatives:

- https://ate.dev, https://ate.dev/llms.txt, https://ate.dev/llms-full.txt, https://github.com/agent-substrate/substrate
- https://cloud.google.com/blog/products/containers-kubernetes/bringing-you-agent-sandbox-on-gke-and-agent-substrate
- https://opensource.googleblog.com/2026/11/sandboxing-untrusted-ai-agents-at-scale.html
- https://docs.cloud.google.com/kubernetes-engine/ai-ml/about-agent-substrate
- https://github.com/kubernetes-sigs/agent-sandbox (suspend keeps the volume only; memory snapshots only through a GKE feature)
- https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md
- https://github.com/google/gvisor/blob/master/g3doc/user_guide/checkpoint_restore.md
- https://github.com/kata-containers/kata-containers/blob/main/docs/Limitations.md
- https://docs.e2b.dev/sandbox/persistence.md, https://github.com/e2b-dev/infra
- https://github.com/apple/container

Hercule: `GLOSSARY.md`; `docs/spec/03-controller-and-runners.md`; `docs/spec/06-providers.md` sections 1 to 4 and 15; `docs/spec/13-security.md`; `docs/spec/16-open-items.md`; ADRs 0002, 0003, 0018, 0028, 0036, 0039, 0048; issue [#587](https://github.com/theagenticage/hercule/issues/587); `docs/research/antigravity-harness.md` on branch `research/antigravity-harness`.

Quotes that could not be confirmed word for word on a second read are not used. Two things the first read reported and the second did not find: a `--dangerously-allow-all` flag, and the sentence "Use a custom plugin to control tool use". Neither is relied on here.
