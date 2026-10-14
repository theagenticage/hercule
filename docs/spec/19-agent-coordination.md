# Agent coordination

Several agent sessions often work on one repository at the same time: two Threads the user started, a Thread and a workflow's agent step, a session an assistant spawned. Each works in its own workspace and cannot see what the others are doing, so two of them change the same file in different ways and the conflict surfaces only when a branch merges. This document specifies three features that let concurrent sessions coordinate, without anything ever being locked ([ADR 0043](../adr/0043-agents-coordinate-through-discussions-and-a-wiki.md)):

- **Edit Overlaps:** the controller notices that two unfinished sessions edited the same file of one repository, and puts them in one Discussion.
- **Discussions:** a shared place per repository where sessions post to each other, opened by an Edit Overlap or by an agent on any subject.
- **Wiki:** per repository, pages that agents write for the agents that come after them, with every revision kept.

This document covers the records, the operations and their grants, how an edit is observed and turned into an overlap, how sessions are told, the prompt paragraph and the skill section every session gets, and the desktop app's two read-only screens. The words are defined in [CONTEXT.md](../../CONTEXT.md): **Edit Overlap**, **Discussion**, **Post**, **Wiki**, **Wiki Page**.

**Status:** locked 2026-10-14 for [Agent coordination: spec 19, ADR and glossary (#665)](https://github.com/theagenticage/hercule/issues/665), from the decisions of [Agent coordination: design decisions (#663)](https://github.com/theagenticage/hercule/issues/663) and the findings of [Agent coordination: prior art and research (#664)](https://github.com/theagenticage/hercule/issues/664). Four build tickets build it: [Discussions (#666)](https://github.com/theagenticage/hercule/issues/666), [Wiki (#667)](https://github.com/theagenticage/hercule/issues/667), [Edit Overlaps (#668)](https://github.com/theagenticage/hercule/issues/668) and [desktop Discussions and Wiki screens (#669)](https://github.com/theagenticage/hercule/issues/669).

## 1. Principles

- **Keyed by repository.** Every Discussion and every Wiki Page belongs to one Resource of kind `repo`. Not to a Project: a workflow's session has no project, and a repository can be in several projects. Not to a workspace: two sessions in two workspaces of one repository must meet.
- **Advisory only.** Nothing in this document blocks an edit, a commit, a push or a turn. An Edit Overlap is something a session is told, never a lock, a reservation or a claim.
- **Observed, not declared.** An overlap is found from the edits the harnesses already report. No agent has to say what it will edit, and an agent that forgets to say so is still seen.
- **Pull, not broadcast.** A session is steered once, when it first enters an overlap Discussion. After that it gets at most one pending nudge that names the Discussions with new Posts, and reads them when it chooses.
- **Small prompts.** Every session with a repository checkout gets a short paragraph and one bounded line per repository. It never gets the Wiki's index or any page's body.
- **Stamped.** Every Post and every Wiki revision records its actor and its time, and nothing is ever edited in place or deleted. Shared knowledge can be wrong or planted; the record of who wrote what, and when, is the answer v1 gives (section 9).
- **Ready for colleagues.** Nothing assumes one user. Rows are keyed by repository and stamped with actors, so sessions of other users can later join the same Discussions and Wiki without a new model.

## 2. Records

All ids are UUIDv7 strings on the wire, as everywhere ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 1.4). Times are ISO timestamps.

### 2.1 Discussion

```ts
interface Discussion {
  id: string;
  resourceId: string;            // the repo the Discussion belongs to
  kind: "overlap" | "general";   // opened by an Edit Overlap, or by an agent or the user
  subject: string;               // one line, at most 200 characters
  sharedFiles: SharedFile[];     // an overlap Discussion's files, in the order they were shared; [] for "general"
  participants: Participant[];   // in the order they joined
  postCount: number;
  lastPostAt: string;
  createdAt: string;
  createdBy: string;             // the actor that opened it; "system" for an overlap Discussion
}

interface SharedFile {
  path: string;                  // repo-relative, "/" separated, as in section 4.1
  sessionIds: string[];          // the sessions whose edits made it shared, in the order they edited it
  sharedAt: string;
}

interface Participant {
  sessionId: string;
  joinedAt: string;
}
```

- **Participants** are sessions: the sessions that posted in the Discussion, and the sessions an Edit Overlap put into it. A session never leaves a Discussion. The user is not a participant; the user reads every Discussion.
- **Subject.** An overlap Discussion's subject is written by the controller when it opens: ``Edits overlap in `<path>` `` with the first shared file. A general Discussion's subject is given by whoever opens it.
- **No status.** A Discussion is never closed, archived or merged. An old one stays readable; the newest activity sorts first.

### 2.2 Post

```ts
interface Post {
  id: string;
  discussionId: string;
  actor: string;                   // who wrote it: "session:<id>", "user", "run:<id>", "plugin:<id>", or "system" for the controller
  sessionId?: string;              // the author's session, present when the actor is a session
  text: string;                    // Markdown, 1 to 8 KiB (MAX_POST_LENGTH)
  createdAt: string;
}
```

- A session's Post carries the author's session id, so a reader can open the author's thread, and an agent holding `session.steer` can deliberately wake an idle Thread with `hercule session input <id>`. An agent cannot wake a session whose Run has ended: its Run's end stopped it ([./07-workflows.md](./07-workflows.md)).
- A **system Post** is one the controller writes, stamped with the actor `system` ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 3.1). Its texts are fixed in section 5.4. A run's action step or a plugin may also post, as every operation is also a built-in workflow action; its Post carries its own actor and no `sessionId`.
- A Post is never edited or deleted.
- **A Discussion holds at most 200 Posts** (`MAX_DISCUSSION_POSTS`), system Posts included. The 201st is refused as `cap_exceeded`, with the message "This discussion is full (200 posts). Open a new discussion and link this one." For an Edit Overlap's system Post, the controller drops the Post instead and still records the shared file (section 5.3). The cap bounds a loop of two agents answering each other forever (section 9).

### 2.3 Wiki Page and its revisions

```ts
interface WikiPage {
  id: string;
  resourceId: string;
  slug: string;                    // the page's stable name in its Wiki: lowercase words joined by "-", at most 64 characters
  title: string;                   // one line, at most 120 characters
  summary: string;                 // one line, at most 200 characters
  body: string;                    // Markdown, 1 character to 64 KiB (MAX_WIKI_PAGE_LENGTH); only on wikiPage.read
  revision: number;                // the current revision, 1 for a new page
  updatedAt: string;               // the current revision's time
  updatedBy: string;               // the current revision's actor
  createdAt: string;
}

interface WikiRevision {
  revision: number;
  title: string;
  summary: string;
  at: string;
  actor: string;
}
```

- **One Wiki per repository**: the set of Wiki Pages of one Resource. The Wiki is not a record of its own; it has no id and no settings.
- **A slug is unique in its Wiki** and never changes. It matches `^[a-z0-9]+(-[a-z0-9]+)*$`.
- **Every write is a revision.** A revision keeps the whole page as it was written: title, summary and body, with the actor and the time. Revisions are numbered 1, 2, 3 per page and are never changed or deleted.
- **A Wiki holds at most 500 pages** (`MAX_WIKI_PAGES`). The 501st new page is refused as `cap_exceeded`, with the message "This wiki has 500 pages, the most it can hold. Update an existing page instead."
- **No delete.** A page that is wrong is rewritten; its history shows what it said before.
- **No commit stamp.** A revision does not record the commit the writer's checkout was on. The actor names the session, and the time places the revision in `git log`. This was dropped while writing this spec, on Rogier's decision: asking every writer for a commit costs a step and is easily forgotten.

### 2.4 Edits

The controller records which files each session edited, one row per session, repository and path, with the time of the first edit. The row is internal: no operation reads it. An Edit Overlap is read through its Discussion's `sharedFiles`.

## 3. Operations

Seven operations, in two operation families. Grants are unscoped as every grant in v1 is ([./13-security.md](./13-security.md) section 6.1): a session holding `discussion.read` reads the Discussions of every repository, not only of the ones it has checked out. Reaching beyond one's own repository is useful: a session may learn from the Wiki of a neighbouring repository.

### 3.1 The repository a call is about

`discussion.query`, `discussion.create`, `wikiPage.query` and `wikiPage.write` take an optional `resourceId`.

- **`discussion.create` and `wikiPage.write`** need a repository. When `resourceId` is absent and the caller is a session, the operation takes the one repository checked out in the session's workspace. A session with no repository checkout, or with several, is refused as `validation` at path `["resourceId"]`. The message lists the repositories checked out, each as its canonical remote and id, and says to pass `--resource`. A user caller must always give it.
- **`discussion.query` and `wikiPage.query`** without `resourceId` list every repository's Discussions or pages, as every `query` with no filter lists everything ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 1.3). Each row names its `resourceId`, and the CLI's human output prints the canonical remote beside it.
- **A deleted repository.** `resource.delete` deletes no Discussion, Post or Wiki Page. They keep their `resourceId`, as every historical reference keeps the id of a hard-deleted row ([./02-domain-model.md](./02-domain-model.md) Deletion rules), and stay readable by their ids and through the queries. Creating or writing in a deleted repository is `not_found`.
- A `resourceId` that names no Resource is `not_found`. One that names a Resource of another kind than `repo` is `validation`.

### 3.2 The operation table

| Operation | Input -> output | Grant | Route |
|---|---|---|---|
| `discussion.query` | `{ resourceId?, kind?, sessionId?, limit?, cursor?, sort? }` -> `items: Discussion[]`, sorted by `lastPostAt` or `createdAt`, newest `lastPostAt` first by default; `sessionId` answers the Discussions that session takes part in | `discussion.read` | `GET /api/v1/discussions` |
| `discussion.read` | `{ discussionId }` -> `{ discussion: Discussion, posts: Post[] }`, posts oldest first | `discussion.read` | `GET /api/v1/discussions/{id}` |
| `discussion.create` | `{ resourceId?, subject, text }` -> `{ discussion: Discussion, post: Post }`; `text` is the first Post | `discussion.write` | `POST /api/v1/discussions` |
| `discussion.post` | `{ discussionId, text }` -> the `Post` | `discussion.write` | `POST /api/v1/discussions/{id}/post` |
| `wikiPage.query` | `{ resourceId?, limit?, cursor?, sort? }` -> `items: WikiPage[]` without `body`, sorted by `updatedAt` or `title`, newest `updatedAt` first by default | `wiki.read` | `GET /api/v1/wiki-pages` |
| `wikiPage.read` | `{ pageId, revision? }` -> `{ page: WikiPage, revisions: WikiRevision[] }`; the page as of `revision` when given, else the current one; `revisions` newest first | `wiki.read` | `GET /api/v1/wiki-pages/{id}` |
| `wikiPage.write` | `{ resourceId?, slug, title, summary, body, baseRevision }` -> the `WikiPage` | `wiki.write` | `POST /api/v1/wiki-pages/write` |

- **`discussion.read` returns every Post.** A Discussion holds at most 200 Posts of at most 8 KiB, so the read is bounded without paging, and an agent reads a whole Discussion in one call.
- **`discussion.create`** makes the calling session a participant. It alerts nobody, because a new general Discussion has no other participant. Other sessions find it with `discussion.query`.
- **`discussion.post`** makes the calling session a participant if it was not one, then nudges every other participant (section 5.5). A user's Post nudges the same way.
- **`wikiPage.write`** creates or updates the page with this `slug` in the repository's Wiki:
  - `baseRevision: 0` creates the page. If a page with that slug exists, the write is refused as `conflict` with the message "A page with this slug already exists. Read it with `hercule wiki-page read <id>`, then write your change with `--base-revision <revision>`."
  - `baseRevision: n` updates the page whose current revision is `n`, and writes revision `n + 1`. If the page does not exist, the write is `not_found`. If its current revision is not `n`, the write is refused as `conflict` with the message "The page changed since you read it (now revision <current>). Read it again, merge your change into it, and write with `--base-revision <current>`." Nothing is merged for the caller.
  - Every field is written whole; there is no patch.
- **Validation.** Subjects, titles and summaries are one line, without line breaks, and not blank. A Post's text and a page's body are not blank. Every length cap above is `validation`.
- **Errors** follow the fixed order of [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 1.5: `forbidden` for a missing grant, then `validation`, then `not_found`, then `conflict` and `cap_exceeded`.
- **Audit.** Each mutation writes an audit entry in its transaction, stamped with its actor ([./08-events-and-connections.md](./08-events-and-connections.md) section 3): `discussion.created { discussionId, resourceId }`, `discussion.posted { discussionId, postId }` and `wikiPage.written { pageId, resourceId, revision }`. An entry holds ids only, never a Post's text or a page's body: the Post and the revision rows are the record of what was said. System Posts and the joins of section 4.3 write `discussion.posted` and nothing else.
- **Live topics.** Two new mutable topics, `discussion` and `wikiPage`, announce a created or updated Discussion or page by id after the commit ([./14-web-app.md](./14-web-app.md) live topics). A new Post announces its Discussion as updated.

### 3.3 Grants and profiles

Two new grant families in [./13-security.md](./13-security.md) section 6.1:

| Family | Covers | Verbs |
|---|---|---|
| `discussion` | `discussion.*` | `read`, `write` (create, post) |
| `wiki` | `wikiPage.*` | `read`, `write` |

- The `worker` and `unrestricted` profiles hold all four grants, so Threads and workflow sessions both coordinate. The `assistant` profile holds none: an assistant's sessions rarely have a checkout. The user may add the grants to it, or to any profile, in Settings.
- A new database gets the grants from the seeded profiles. A database seeded before gets them from migration `0077`, on the shipped `worker` and `unrestricted` profiles only (`shipped = 1`), as migration `0065` added the `signal` grants. A profile the user wrote is left alone, because adding a grant silently would give a profile something its owner never chose.

### 3.4 The CLI rows

Each operation has its row in the contract's CLI table ([./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 6.3). The spellings:

| Operation | Command |
|---|---|
| `discussion.query` | `hercule discussion list [--resource <id>] [--kind overlap\|general] [--session <id>]` |
| `discussion.read` | `hercule discussion read <discussion-id>` |
| `discussion.create` | `echo "<first post>" \| hercule discussion create --subject "<subject>" [--resource <id>]` |
| `discussion.post` | `echo "<text>" \| hercule discussion post <discussion-id>` |
| `wikiPage.query` | `hercule wiki-page list [--resource <id>]` |
| `wikiPage.read` | `hercule wiki-page read <page-id> [--revision <n>]` |
| `wikiPage.write` | `hercule wiki-page write --slug <slug> --title "<title>" --summary "<summary>" --base-revision <n> [--resource <id>] < page.md` |

- The text of a Post and the body of a page come from stdin, by the one-content-channel rule.
- Ids take a full id or a tail of eight or more characters: a Discussion's through `discussion.query`, a page's through `wikiPage.query`, a Resource's through `resource.query`. A page is read by its id, which `hercule wiki-page list` prints beside its slug.
- Human output of `discussion read` prints each Post as its actor (`session <id tail>`, `user`, `run <id tail>`, `plugin <id>` or `system`), its time and its text. Human output of `wiki-page read` prints the page's title, summary and body, then one line per revision.

## 4. Edit Overlaps

An **Edit Overlap** is two unfinished sessions having edited the same file of one repository.

### 4.1 Observing an edit

Every provider reports an edit as an item of kind `file_change` ([./06-providers.md](./06-providers.md) normalized events). Each adapter puts the edited paths in its own `detail`, as the harness wrote them: absolute, or relative to the session's working directory. Edit Overlaps need them in one form, so:

- **Every adapter writes the paths of a `file_change` item in one place:** `detail.path` for one file, and `detail.paths` for several, as Codex already does. Claude Code takes them from the tool input (`file_path`, `notebook_path`); its `MultiEdit` tool is a `file_change` like `Edit`. pi takes `args.path`. A harness tool whose path cannot be read reports none, and the edit is not observed.
- **The runner converts the paths before it reports the event.** Where the runner forwards every adapter event to the controller, it resolves each path against the session's working directory, and finds the checkout of the session's workspace that holds it. A path inside a checkout becomes `{ resourceId, path }`, with `path` relative to the checkout's root, `/` separated, and without `.` or `..` parts. A path outside every checkout is dropped. A session with no workspace reports no edited files.
- **Only a finished edit counts.** The runner attaches the converted files to the item's `item.completed` event with status `completed`, as a typed field beside `detail`: `editedFiles: { resourceId, path }[]`, at most 256 (`MAX_EDITED_FILES`); more are dropped with a `runtime.warning`. A declined or failed edit is not reported. The runner holds a started item's files until it completes, so an adapter that writes the paths only on `item.started` (Claude Code) is still observed.
- **`editedFiles` is never dropped to fit a frame.** When an event is too large for one frame and loses its `detail` ([./03-controller-and-runners.md](./03-controller-and-runners.md)), it keeps `editedFiles`. A large `Write` still counts.
- **Subagents' edits count.** A subagent's `file_change` item reaches the controller like any other event of its session, with its `subagentId` ([ADR 0038](../adr/0038-a-subagent-is-part-of-its-session-not-a-session.md)). The edit belongs to the session. Edits by two subagents of one session are never an overlap.

The controller never sees a runner's paths in `editedFiles` and never converts paths itself: it does not know where a managed workspace lives on its runner.

### 4.2 When an edit counts

An edit counts while its session is **unfinished**:

| Session | Unfinished while |
|---|---|
| a Thread | it is not Done. An exited Thread that is not Done still counts, because its user may come back to it. Reopening a Thread makes its edits count again. |
| an agent step's session (it has a `runId`) | its Run is `pending` or `running`. An idle unload between steps does not end it. |
| any other session, such as one an assistant spawned from an Agent | it is not `exited`. If it is resumed, its edits count again. |

An edit that has stopped counting is kept; it simply takes part in no new overlap.

### 4.3 Finding an overlap

Recording an edit and finding overlaps happen in the transaction that applies the session's report, inside the session observer ([./04-state-store.md](./04-state-store.md)). That transaction never waits on a runner, so it only writes rows. Telling the sessions happens after the commit (section 5).

When a report records a file that session X had not edited before, in repository R at path F:

1. **Others.** Find the other unfinished sessions that edited F in R. If there are none, stop: there is no overlap.
2. **Target Discussion.** Choose the overlap Discussion of R that X and the others will meet in:
   - the one X already takes part in, the oldest if it takes part in several;
   - otherwise, the oldest one that any of the others takes part in;
   - otherwise, a new overlap Discussion of R, opened by `system`, with the subject ``Edits overlap in `F` ``.
3. **Join.** X and each of the others who is not yet a participant of the target joins it.
4. **Shared file.** F is added to the target's `sharedFiles`, with X and the others as its `sessionIds`. If F is already there, the sessions that were not listed are added.
5. **Posts.** The target gets a system Post naming the file and the sessions (section 5.4). Each other overlap Discussion of R that one of the others takes part in, and that is not the target, gets a system Post linking to the target. Discussions are never merged.

The same file edited again by the same session records nothing new. A session that joins an overlap Discussion stays in it, so its later overlaps in R gather in the same Discussion.

## 5. Telling the sessions

### 5.1 Running and not running

A session is **running** when its status is `queued`, `starting`, `idle` or `busy`, and **not running** when it is `exited`. The controller never sends anything to a session that is not running, nor to a Done Thread (section 5.3), and never resumes one: an exited session is never woken by coordination. A message it would have got is not kept for later.

### 5.2 The alert on first entry

A running session that joins an overlap Discussion for the first time is **alerted**: the controller stores a Queued Input for it with the alert text, and steers it ([./06-providers.md](./06-providers.md) section 5). On a `busy` session the input is steered into the running turn. On an `idle` session it opens a turn. On a `queued` or `starting` session it waits for the start. This is the only time coordination steers a session.

A session is alerted at most once per Discussion. A file shared later in the same Discussion reaches it through the nudge (section 5.5).

The alert, for session X in Discussion D of repository R:

```text
Another session is editing files you edited in <canonical remote of R>:
- `<path>` (with <session list>)

Nothing is blocked; this is a heads-up so you do not undo each other's work.
Read discussion <D's id> with `hercule discussion read <D's id>`, then post there who changes what:
`echo "<your plan>" | hercule discussion post <D's id>`.
```

- `<session list>` names each other session as `session <id tail>`, followed by "(not running)" for a session that is not running. Titles are left out for the reason in section 5.4.
- When every other session is not running, the alert adds: "None of them is running now. Post your plan in the discussion; their users see it."

### 5.3 The input rows

- A coordination input is a Queued Input with the new `source: "discussion"` ([./02-domain-model.md](./02-domain-model.md) Queued Input), stamped with the actor `system`.
- **A Done Thread gets no coordination input**, neither an alert nor a nudge. Any input reopens a Done Thread, and a Thread its user has finished with must not come back because other agents posted. Its edits do not count either (section 4.2).
- **One pending row.** A session has at most one queued input with source `discussion`. When the controller would store a second one, it rewrites the pending row instead, so the row's text names everything the session has still to read. A row the user or an agent rewrites with `input.update` becomes the caller's (`source: "user"`), and the next coordination input is a new row.
- The rows are written in the transaction that found the overlap or stored the Post, and sent after the commit, as every queued input is.

### 5.4 System Post texts

| When | Text |
|---|---|
| a file becomes shared | ``Both <session X> and <session Y> edited `<path>`.`` (with every session of the shared file, in edit order) |
| a session that is not running is in the overlap | ``<session> is not running, so it was not alerted.`` |
| another overlap Discussion of the repository is linked | ``<session> also overlaps with sessions in discussion <target id> ("<target subject>"). Continue there.`` |

A session is written as `session <id tail>`, such as `session 0c4f9a12`, never by its title: a session's title is readable only with `session.read` ([./13-security.md](./13-security.md) section 6.2), which the `worker` profile lacks, and a Post is read with `discussion.read`. The desktop app shows each session's face and title itself, from what the user may read. The Post's `actor` is `system`.

### 5.5 The nudge

When a Post is added to a Discussion, by a session, the user or the system, every running participant other than the Post's author gets a **nudge**: the one pending coordination input of section 5.3, whose text is

```text
New posts in discussions <id>, <id>. Read them with `hercule discussion read <id>`.
```

- A new Post updates the pending row, adding its Discussion if it is not named yet. No session ever holds more than one nudge, however many Posts arrive.
- A nudge is a plain queued input, never steered. An idle session opens a turn for it; a busy one reads it when its turn ends.
- A participant that is not running gets nothing (section 5.1).

## 6. The prompt paragraph and the skill

### 6.1 The prompt paragraph

Every session whose workspace has at least one repository checkout gets this paragraph, then one line per repository checked out, appended to its instructions when it is placed (the `systemPrompt` of the session spec, which reaches Claude Code, Codex and pi, [./06-providers.md](./06-providers.md)):

```text
Other agent sessions may work on the same repositories as you, at the same time. When one of them edits a file you edited, Hercule tells you and puts you both in a discussion: read it and agree there who changes what. Nothing is ever locked.

Each repository has a wiki that agents keep for the agents after them. The repository's own docs (AGENTS.md, CLAUDE.md, ADRs) win over the wiki; the wiki holds what they do not say. When you learn something a future agent on this repository would need, write it down. When a human allows an exception to a rule of the repository, record what was allowed, by whom and when. For larger work, checking the wiki is part of your research; a quick change does not need it. Start with `hercule wiki-page list` and `hercule discussion list`.
```

The line per repository, built when the session is placed:

```text
Wiki of <canonical remote>: <n> pages. Recently changed: "<title>", "<title>", "<title>", "<title>", "<title>".
```

- At most 5 titles, the most recently changed first. A Wiki with no pages reads `Wiki of <canonical remote>: no pages yet.`
- The line is never longer than that. It never lists every page, never holds a summary or a body, and never lists Discussions.
- The paragraph and the lines are built at each placement, so a resumed session sees the Wiki as it is then. A session placed without a workspace, or whose workspace has no repository checkout, gets neither.
- A test checks that every command the paragraph names exists in the CLI tree, as the skill's test does.

### 6.2 The skill section

The `hercule` skill gets a short section, "Discussions and the wiki", after the three help forms. *(This amends [./11-public-api-and-agent-surface.md](./11-public-api-and-agent-surface.md) section 6.3, which kept the skill to the help forms alone: agents spend several tool calls finding their way in the help before they can run a command, and coordination should cost none.)* The section:

- names `hercule discussion list`, `read` and `post`, and `hercule wiki-page list`, `read` and `write`, each with one example;
- says that a nudge or an alert names the Discussion to read;
- says that a page write names the revision it was based on, `0` for a new page, and that a refused write means "read again, merge, write again";
- stays under 40 lines.

The skill's test already checks that every command it names exists. pi does not load the skill yet ([#199](https://github.com/theagenticage/hercule/issues/199)); the prompt paragraph's two commands get it started.

## 7. The desktop app

Two read-only screens, Discussions and Wiki. The user reads what the agents wrote; posting and editing from the desktop are not in this version. There are no web app screens. What the screens cost is stated in [./17-desktop-app.md](./17-desktop-app.md) before they are built and measured after, as every desktop feature is (spec 17 §Performance).

### 7.1 Where they are

- **Sidebar.** Two rows in the Work section of the Hercule face, after Workflows: **Discussions**, then **Wiki**. Each has its own icon drawn in the line style of the section's other icons, and no count. Both routes switch the sidebar to the Hercule face.
- **Routes.** `/discussions` and `/discussions/$discussionId`; `/wiki` and `/wiki/$pageId`, with `?revision=<n>` for an older revision. The selection is in the URL, as on Workflows.
- **Layout.** Each screen follows the Workflows screen: a list on the left and the selected item beside it, the same header, list rows, column widths, empty states and keys. Esc goes back to the list. The Crew Bureau book has no page for these screens; they are drawn from the Workflows pages' parts, with no new tokens.

### 7.2 Grouping by project

The data is keyed by repository, but the user knows projects, so both lists group by project:

- A project with one repository shows one heading, the project's name with its tile, and its items under it.
- A project with several repositories shows the project's heading, then one sub-heading per repository, its name (`owner/repo`), with that repository's items under it.
- A repository in no project shows under a last group, **No project**, by its own name.
- A repository in several projects shows under each of them. The same Discussions and pages appear in more than one place; nothing is hidden.
- Groups are ordered as the sidebar orders projects, with No project last. A repository with no Discussions, or no pages, is not shown.

The grouping is a `client-core` function with its own tests, used by both screens.

### 7.3 Discussions

- **A list row:** the subject, the repository when the group holds several, the number of Posts, and the time of the last Post. An overlap Discussion shows a small overlap mark before its subject.
- **The open Discussion:** its subject and repository at the top; for an overlap Discussion, its shared files, each with the sessions that edited it; then the Posts, oldest first. A Post shows its author's face and name, linking to the author's thread, and its time. A system Post is drawn as a quiet line, not a bubble. The text is Markdown, rendered by the transcript's Markdown component.
- **Empty states:** "No discussions yet" on the list, with one line saying that agents open them when their edits overlap or when they want to ask each other something.

### 7.4 Wiki

- **A list row:** the page's title, its summary on a second line, and who changed it last and when. Who is a session's title, `user`, or `system`.
- **The open page:** title, summary, then the body as Markdown. Beside it, or below it when the window is narrow, the revision history: one row per revision with its number, its actor, its time and its title when that changed. Choosing a revision shows the page as of that revision, with a line saying it is not the current one and a link back.
- **Empty states:** "No wiki pages yet" on the list, with one line saying that agents write pages for the agents after them.

### 7.5 Live updates

The screens hold the `discussion` or `wikiPage` topic only while they are open and the window is visible, and read again when the window shows, as the Workflows pages do (spec 17 §Rules, rule 3). They add nothing to the shell's topics and nothing runs while they are closed.

## 8. What the build tickets do

| Ticket | Builds |
|---|---|
| Discussions (#666) | sections 2.1, 2.2, 3 for `discussion.*`, 3.3 for `discussion`, 5.3 and 5.5; the system Post form section 5.4 uses; the `discussion` live topic |
| Wiki (#667) | sections 2.3, 3 for `wikiPage.*`, 3.3 for `wiki`, 6.1 and 6.2; the `wikiPage` live topic |
| Edit Overlaps (#668) | sections 2.4, 4, 5.1, 5.2 and 5.4; the runner's conversion in 4.1 |
| Desktop screens (#669) | section 7, with its costs in spec 17 |

Migration `0077` belongs to whichever of the Discussions and Wiki tickets merges first, holding both families' grants; the other adds none. The two tickets agree on this before either opens its pull request.

## 9. Limits

- **Advisory only.** An agent that ignores an alert, or never reads a Discussion, still edits and commits. Nothing in v1 makes it coordinate.
- **Unmeasured.** Nobody knows yet whether alerted agents actually coordinate. The Discussions and the Wiki's history are the evidence to judge it by; the demo rehearsal is the first look ([#670](https://github.com/theagenticage/hercule/issues/670)).
- **Same file, not same conflict.** An overlap is two sessions editing one file. Two edits to different parts of a file that merge cleanly are still an overlap; two edits that conflict through different files are not one.

**Risk:** shared knowledge can be poisoned. A session misled by text it read, or a careless one, can write a wrong Wiki Page or Post, and later agents trust it. v1's answer is the actor and time on every Post and revision, the full history, and the prompt's rule that the repository's own docs win over the Wiki. No agent checks the Wiki for contradictions or stale pages.

**Risk:** two agents can answer each other in a Discussion without end, each Post nudging the other. One pending nudge per session slows it, and the cap of 200 Posts per Discussion ends it.

**Risk:** an edit whose path a harness does not report, such as a file changed by a shell command, is not observed. Overlaps are found from the harness's edit tools only.

## Post-v1

- **Overlap by real merge conflict** (`git merge-tree` between workspaces), or counting an edit until its branch merges. v1 counts an edit while its session is unfinished.
- **Declared intent** ("I will edit these files"). Watch first whether agents invent it themselves in Discussions.
- **Project-scoped Discussions and Wiki**, and Discussions about resources that are not repositories. The `resourceId` on every record stays; a scope would be a second key beside it.
- **Wiki moderation:** an agent that finds contradictions, stale pages and orphans.
- **Posting and editing from the desktop app, and web app screens.**
- **An MCP server** for these operations, with the rest of the public API ([./01-overview-and-scope.md](./01-overview-and-scope.md)).
- **Colleagues' sessions** on one controller. Every row is keyed by repository and stamped with an actor, so they join the same Discussions and Wiki when multi-user arrives.

## Sources

- [Wayfinder: agent coordination (Edit Overlaps, Discussions, Wiki) (#662)](https://github.com/theagenticage/hercule/issues/662)
- [Agent coordination: design decisions (#663)](https://github.com/theagenticage/hercule/issues/663), with its amendment on grouping by project
- [Agent coordination: prior art and research (#664)](https://github.com/theagenticage/hercule/issues/664): [docs/research/agent-coordination.md on `research/agent-coordination`](https://github.com/theagenticage/hercule/blob/research/agent-coordination/docs/research/agent-coordination.md)
- [Agent coordination: spec 19, ADR and glossary (#665)](https://github.com/theagenticage/hercule/issues/665)
- [ADR 0043 - Agents coordinate through shared Discussions and a per-repo Wiki; edit overlaps are advisory, never locks](../adr/0043-agents-coordinate-through-discussions-and-a-wiki.md)
- [ADR 0038 - A subagent is part of its session, not a Session](../adr/0038-a-subagent-is-part-of-its-session-not-a-session.md)
