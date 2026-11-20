# An agent operating Hercule by CLI and by MCP, measured

These facts back the decision whether Hercule's own API should be offered to sessions as MCP tools beside the `hercule` CLI. They come from 280 runs of real harnesses against a real controller on 2026-11-17. The scripts and the result rows are in [`docs/design/mcp/benchmark/`](../design/mcp/benchmark/); the page that draws them is [`docs/design/mcp/index.html`](../design/mcp/index.html).

## Method

- **The controller** is this branch's compiled binary (`pnpm build:binary`), started in a throwaway Hercule Home by `serve.ts` and deleted afterwards. Nothing touched `~/.hercule`.
- **The harnesses** are Claude Code 2.1.325, headless (`claude -p`), with Sonnet 5.5 and with Haiku 5.5, and Codex 0.169.0 (`codex exec`) with its default model. Both are newer than the versions Hercule pins. Each run starts in an empty directory, with no user settings, no user MCP servers and no memory.
- **Four arms**, each the only way to reach Hercule in its run:
  - `cli`: what a session gets today. The `hercule` binary on PATH, the session orientation, and the Hercule skill, delivered the way the runner delivers them to that harness.
  - `mcp-search` (Claude Code) and `mcp-ops` (Codex): one MCP tool per operation, 214 tools. The harness defers them: it shows the model the tool names, and loads a tool's schema when the model searches for it. Both harnesses do this by default.
  - `mcp-meta`: two MCP tools. `hercule_help` lists the operations or describes one; `hercule_call` runs one.
  - `mcp-eager` (Claude Code, Sonnet only, one run per task): the 214 tools with `ENABLE_TOOL_SEARCH=false`, so every schema is in every request.
- **The MCP server is derived from the CLI's own command tree** (`mcp-server.ts`), so both surfaces have the same operations, the same help text per field, and send a call through the same code. A tool returns the operation's JSON output.
- **Ten tasks**, each in a project of its own that is seeded before the run and deleted after it, with a look-alike project beside it:

  | Task | What the agent is asked |
  |---|---|
  | `count` | How many tasks in the project are in review. |
  | `aggregate` | How many tasks are not done or dropped and have no label. The API has no such filter. |
  | `export` | Write every task's id and title to a file. |
  | `create` | Create a task with a title, priority, two labels and a two-paragraph description holding a quote, backticks and a `$`. |
  | `update` | Find a task by what it is about, move its stage, add a label and remove one. |
  | `block` | Record that one task waits on another. |
  | `initiative` | Put the three tasks about checkout on an initiative. |
  | `profile` | Create a Permission Profile with three grants, named by what they allow. |
  | `bulk` | Change every task with a label that is not done yet: four tasks, two fields each. |
  | `wiki` | Add a section to the end of a wiki page and keep the rest as it is. |

- **A run passes** when the controller's state afterwards is what was asked for and nothing else changed. For the two number tasks the reply's last number is checked. For `export` the file is checked.
- **Three runs per task and arm**, arms interleaved. 30 runs per arm on each of the three harness and model pairs, plus 10 for `mcp-eager`: 280 runs.
- **Measures** are read from the harness's own event stream: the context of the first request, input tokens over every request (cached or not), output tokens, requests, tool calls, calls that only read documentation, tool calls that were refused, and wall time. Codex reports usage per turn, so it has no per-request figures.

## Results

Medians per run.

| Harness and model | Arm | Passed | Requests | First request | Input tokens | Output tokens | Tool calls | Lookups | Time |
|---|---|---|---|---|---|---|---|---|---|
| Claude Code, Sonnet | `cli` | 30/30 | 6 | 17,831 | 122,728 | 536 | 5 | 2 | 13.2 s |
| | `mcp-search` | 30/30 | 5 | 20,704 | 120,383 | 538 | 4 | 1 | 10.7 s |
| | `mcp-meta` | 30/30 | 6 | 17,664 | 124,348 | 810 | 7 | 4 | 13.1 s |
| | `mcp-eager` | 10/10 | 4 | 109,022 | 445,326 | 446 | 3 | 0 | 9.7 s |
| Claude Code, Haiku | `cli` | 30/30 | 6 | 18,656 | 146,455 | 1,162 | 5 | 2 | 17.4 s |
| | `mcp-search` | 30/30 | 4 | 21,526 | 107,314 | 817 | 4 | 1 | 14.0 s |
| | `mcp-meta` | 30/30 | 6 | 18,489 | 145,010 | 1,224 | 8 | 5 | 16.5 s |
| Codex, default model | `cli` | 30/30 | - | - | 106,504 | 335 | 6 | 3 | 22.3 s |
| | `mcp-ops` | 30/30 | - | - | 109,756 | 274 | 2 | 0 | 22.4 s |
| | `mcp-meta` | 30/30 | - | - | 136,930 | 378 | 6 | 4 | 27.2 s |

### What a session carries before it does anything

A Claude Code session with Sonnet and no Hercule surface at all has 17,266 tokens in its first request. On top of that:

| Arm | Tokens added |
|---|---|
| `mcp-meta` | about 400 |
| `cli` | about 600 |
| `mcp-search` | about 3,400 |
| `mcp-eager` | about 91,800 |

Every session pays this, also one that never calls Hercule. The eager figure is paid again in every request.

### Per task, Claude Code with Sonnet

Median input tokens, requests and wall time.

| Task | cli | mcp-search | mcp-meta | mcp-eager |
|---|---|---|---|---|
| `count` | 84K, 4 req, 10 s | 91K, 4 req, 10 s | 97K, 5 req, 10 s | 330K, 3 req, 6 s |
| `aggregate` | 87K, 4 req, 13 s | 93K, 4 req, 11 s | 100K, 5 req, 13 s | 333K, 3 req, 7 s |
| `export` | 88K, 4 req, 10 s | 121K, 5 req, 11 s | 125K, 6 req, 13 s | 446K, 4 req, 11 s |
| `create` | 120K, 6 req, 11 s | 89K, 4 req, 10 s | 95K, 5 req, 11 s | 330K, 3 req, 8 s |
| `update` | 138K, 6 req, 11 s | 125K, 5 req, 10 s | 149K, 7 req, 11 s | 447K, 4 req, 11 s |
| `block` | 139K, 6 req, 15 s | 121K, 5 req, 9 s | 147K, 7 req, 12 s | 447K, 4 req, 9 s |
| `initiative` | 143K, 6 req, 17 s | 131K, 5 req, 16 s | 132K, 6 req, 17 s | 449K, 4 req, 11 s |
| `profile` | 82K, 4 req, 15 s | 64K, 3 req, 17 s | 95K, 5 req, 17 s | 218K, 2 req, 12 s |
| `bulk` | 178K, 8 req, 16 s | 120K, 5 req, 10 s | 124K, 6 req, 13 s | 444K, 4 req, 10 s |
| `wiki` | 120K, 6 req, 13 s | 172K, 5 req, 12 s | 220K, 8 req, 18 s | 495K, 4 req, 10 s |

### Refused calls

A refused call is a tool call that came back as an error, which the agent then corrected. Every run still passed.

| Harness and model | cli | tool per operation | mcp-meta |
|---|---|---|---|
| Claude Code, Sonnet | 6 of 30 runs | 0 of 30 | 4 of 30 |
| Claude Code, Haiku | 1 of 30 | 3 of 30 | 8 of 30 |
| Codex | 0 of 30 | 0 of 30 | 0 of 30 |

- **Four of Sonnet's six CLI refusals were the same one**: `hercule task list --project <tail>`. The flag took only a full id, while most flags take a tail of eight characters, and the human-readable output prints tails. The CLI table on this branch now resolves a project tail on the six flags that did not (`task list`, `task create`, `task update`, `initiative list`, `resource list`, `workspace list`).
- **`mcp-meta` refusals are wrong field names**: `label` for `labels`, `ref` for `id`, `repository` for `resourceId`. The free-form `input` object has no schema the harness can check.
- **Haiku's `mcp-search` refusals** are malformed JSON in the tool input, which the harness refuses before the call is sent.

## Findings

- **Success is the same on every surface.** 280 of 280 runs passed. This measurement gives no support for "more correct calling" with MCP, on a strong model or on a small one.
- **A tool per operation saves about one request per task on Claude Code**: 5 against 6 on Sonnet, 4 against 6 on Haiku, and 2 to 3 seconds of wall time. The agent finds its tools with one search. With the CLI it reads help first, a median of 2 lookups a task.
- **On Codex the two are level**: 22.4 s against 22.3 s, 110K input tokens against 107K.
- **Tokens read per task are level on Sonnet and Codex**, and lower with a tool per operation on Haiku (107K against 146K).
- **The CLI adds the least to every session**: about 600 tokens against about 3,400. Loading the tools eagerly costs about 91,800 tokens in every request, 3.6 times the input tokens of the CLI for the same result.
- **Each surface has a kind of task it is better at.**
  - Moving data out of Hercule: the CLI pipes it into a file (`export`: 88K against 121K tokens).
  - Several writes in a row: tool calls run side by side in one request (`bulk`: 120K against 178K, 5 requests against 8).
  - A text with characters a shell treats specially: both passed every time. The CLI used a quoted heredoc.
- **The two-tool shape is the weakest of the three.** It has the most lookups, the most refused calls, the most output tokens, and it is the slowest on Codex.

## What this does not show

- The agent held the user's API key, not a Session Token with a Permission Profile. No run met a 403, and the first version of the `initiative` task asked for something only the user may do. Codex with the CLI refused it from the help text alone; the task was changed and run again on every harness.
- No run had both the CLI and the MCP tools. Whether two surfaces for the same operations confuse an agent is not measured.
- Ten tasks over tasks, projects, initiatives, the wiki and profiles. No session spawning, no transcripts, no workflow source, no long-running work.
- Three runs per task and arm. A difference of 10% in tokens is within the spread between runs of one cell.
- One machine, one day, and harness versions newer than the pinned ones. Tool search on the pinned Claude Code 2.1.263 is documented as on by default, and was not run.
- Cost in dollars is not reported. The harness's figure depends on what an earlier run left in the prompt cache, so it varied by a factor of five for identical work.

## Running it again

```
pnpm build:binary
bun docs/design/mcp/benchmark/serve.ts /tmp/bench/state.json &        # a controller in a throwaway home
bun docs/design/mcp/benchmark/bench.ts /tmp/bench/state.json /tmp/bench/results.jsonl --model sonnet
bun docs/design/mcp/benchmark/bench.ts /tmp/bench/state.json /tmp/bench/codex.jsonl --harness codex --model default
python3 -I docs/design/mcp/benchmark/summarize.py /tmp/bench/results.jsonl /tmp/bench/codex.jsonl
kill %1                                                                # stops the controller and deletes the home
```

The runs spend real model tokens on the accounts the two CLIs are signed in to. This measurement's Claude runs, the repeated ones included, came to about 10 dollars at API prices by the harness's own count.
