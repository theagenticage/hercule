# The sidebar, regrouped - the team exercise and four briefs

PROTOTYPE. The brief behind four directions for organizing the desktop sidebar's threads, drawn
in Crew Bureau 2. The book (`index.html` beside this file) tells the story; each direction has
its own story page (`<direction>/index.html`) and a live screen (`<direction>/desktop.html`).

## 1. The question

Rogier now runs most work as a small crew: he starts one thread, and that thread starts one or
two more to work with it, usually in its own worktree. "Migrate unmigrated endpoints to MwsResult"
(Claude) starts "Adversarial review of MwsResult framethegame endpoints" (Codex). The lead writes
the partner a better brief than Rogier would, so this will stay the common way a partner is
born. Now and then Rogier adds one himself with the header's `+`.

The sidebar does not know any of this. Every thread is a row like any other, so:

- **The list doubles.** Four pieces of work in flight are nine rows.
- **Nothing ties a pair together.** The rows sort by when each thread started, so a partner can
  land anywhere in its project, between rows of other work.
- **The rows do not say which work they belong to.** Titles differ ("Migrate…" and
  "Adversarial review of…"), and line 2 is often only the machine ("atlas"), because the
  controller generated the branch.
- **The header knows.** Its tabs already list the threads of the open workspace. The sidebar is
  the only place that cannot tell.

> **How does the sidebar show pieces of work, not just threads, so Rogier always knows which row
> belongs to which piece of work, without making a lone thread cost more than it does today?**

Constraints from Rogier:

- Desktop app only. Stay in Crew Bureau. The sidebar can be resized, and ideas outside the
  sidebar are welcome.
- New concepts are allowed, as long as each direction says plainly what new data or spec change
  it needs.
- None of the directions may rule out grouping and sorting options later.
- Four directions, each very different from the others. Each must be lovely to use, obvious to
  someone coming from Claude Code, Codex or T3 Code, and still make them stop and think "huh,
  why didn't anyone do this before?"

## 2. What we know

**The data.** Hercule already records most of what a piece of work needs:

- `sessions.created_by` stores who started a session: `user` or `session:<id>`. The contract does
  not expose it yet. **This gives us lineage for free**: a partner's lead is the session that
  started it.
- `Session.workspaceId` and `Workspace.sessionIds` say which threads share a workspace. This is
  only evidence of a piece of work, not proof: a **main workspace** is long-lived and shared by
  unrelated threads ("Tidy checkout CSS" and "Audit checkout for screen readers" share webshop's
  main workspace on build-box-1). And a partner can work elsewhere: a checker in a scratch
  workspace on another machine.
- Every input carries an `actor`, so **a message one thread sends another is recorded**
  (`session:<id>`). The conversation between a lead and its partner already exists. Nobody shows it.
- `parentSessionId` marks forks only. A Workspace has no name. A Task ("a unit of human intent")
  exists, but threads are not linked to Tasks, and making every thread a Task is too heavy.

**The history.** The desktop sidebar once grouped a project's threads by workspace, under lane
labels. #473 removed that: a project became one flat list, the way T3 Code does it. The lane
label named a workspace, which has no human name, and most workspaces held one thread, so most
labels were noise. Whatever we do must beat that, not bring it back.

**The app today** (spec 17 §The sidebar, #626): Waiting on you on top, then projects. Threads sort
newest started first, five per project with a "more" row. A row is 52px with two lines: the title
and a status word (Working, Approval, Question, or the age), then the provider's mark and where the
thread works. Rows never move when a thread works (#626: "the list moved under the user's
pointer"). The foot counts working, waiting and idle.

**What other tools do** (full notes in `RESEARCH.md`, checked 2026-10-21):

- **VS Code** (1.136) nests "peer chats" sharing one worktree under a session, and combines their
  status and changes on the parent row. **Conductor** makes the workspace the row and puts each
  chat in a tab; its docs name Rogier's exact pattern ("an agent implementing while another
  reviews the same diff"). **Devin Desktop** treats every session as a Space of one, and you drag
  one onto another to group them.
- **T3 Code built this and dropped it**: PR #4458 grouped sibling threads into a "task" and was
  closed unmerged on 30 July 2026, to "restart from a small task-group model". A user called it
  "the biggest thing missing".
- **Nobody fills these gaps:** grouping that happens on its own (theirs is too coarse, or
  manual), **roles** on partners, a defined **status summary** with a pointer to the thread that
  needs you, **one title** for the group, **closing a piece of work** as one act, a group of one
  drawn as a plain row, and a **review surface** that puts the reviewer's findings beside the diff.

## 3. The design team exercise

How a full team would take this on: who sits at the table, what each person worries about, what
they bring, how they work, and the words they use.

### Product owner - "What job is the sidebar hired for?"

- **Concern:** outcomes, not screens. Does the change make Rogier faster at the three jobs he
  hires the sidebar for, without making the common case worse? Is the cost of a new concept
  worth it? Does it close doors on the roadmap (grouping and sorting options, the web app, the
  phone)?
- **Brings:** the job stories, the success measures, the scope line, and the veto on new nouns
  that do not pay for themselves.
- **Approach:** writes job stories and a measurable outcome before anyone draws. Insists each
  direction states what it needs from the controller, because the frontier between "a drawing"
  and "a ticket" is where good ideas die.
- **Says:** jobs to be done (JTBD), outcome over output, success metric, time to find, scope,
  must not preclude, the degenerate case, opportunity cost, MVP, walking skeleton.
- **Asks in the kick-off:** "When Rogier looks at the sidebar, what is he trying to do? And what
  fraction of his threads are alone? If most are alone, we cannot tax them."

**Job stories** (the PO's frame for every critique):

1. **Find:** When I want to get back to a piece of work, I want to find it by what it is, so I do
   not have to remember which of its threads I was in.
2. **Attend:** When any thread of any piece of work needs me, I want to see it and reach it in one
   move, even if its piece of work is folded away.
3. **Oversee:** When I glance at the sidebar, I want to know which pieces of work are moving,
   which are stuck, and which are done, so I know where to spend my attention.
4. **Switch:** When I am in a piece of work, I want to move between its lead and its partners
   without going back to the list.
5. **Finish:** When a piece of work is done, I want to put all of it away at once.

### Lead designer - "What is the idea, and does it belong to Hercule?"

- **Concern:** a strong idea per direction, and four directions that stay far apart. Coherence
  with Crew Bureau: color is who, state is a pose and a mark, places get tints. Hercule's
  unfair advantage is that **every thread is a colleague with a face**. No other tool can show a
  crew.
- **Brings:** the concept, the metaphor, the principles, and the critique. Decides which axis
  each direction pulls, so the four answers are different in kind, not in detail.
- **Approach:** runs the double diamond: diverge wide (a "crazy 8s" round per person), converge
  on four concepts that each pull one lever, then push each to its most convincing form before
  comparing. Kills any direction that starts to look like another.
- **Says:** the big idea, the lever, the signature moment, the hero state, metaphor, design
  principles, divergence and convergence, coherence, craft, "on brand".
- **Asks:** "What is the one thing this direction does that no other tool does? If we cannot say
  it in a sentence, it is not a direction yet."

### UX expert - "What is the object, and what does the eye do?"

- **Concern:** the mental model and the information architecture. What is the primary object:
  the thread, the piece of work, the workspace, the branch? How deep is the tree? What does
  the eye do in the first 300 milliseconds? And the stability rule from #626: rows must not move
  under the pointer.
- **Brings:** the object map (OOUX), the state matrix, the heuristics, and the tests: a
  five-second test, a first-click test, a "find the reviewer of the cart work" task.
- **Approach:** maps the objects and their relations first: Project contains pieces of work, a
  piece of work has a lead and partners, each thread runs in a workspace on a machine. Then
  checks every direction against the edge cases: a group of one, a partner on another machine,
  two unrelated threads in one main workspace, a partner that waits while its group is folded,
  a swarm of 40.
- **Warns:** "Workspace is the wrong key. A main workspace is shared by strangers, and a
  partner may work elsewhere. **Lineage is the honest key**: who started whom. The workspace is
  only evidence."
- **Says:** mental model, object-oriented UX, information architecture, recognition over recall,
  information scent, wayfinding, progressive disclosure, focus and context, overview first then
  details on demand, chunking, Gestalt (common region, proximity, similarity, connectedness,
  common fate), pre-attentive attributes, glanceability, roll-up, the degenerate case, spatial
  memory, stable sort, Fitts's law, Hick's law, a11y tree semantics (`role="tree"`,
  `aria-level`).

### Senior designer - "What does it look like at 13px, in every state?"

- **Concern:** craft and states. Row anatomy at a 272px width, the 4px grid, truncation, how two,
  three or five partners draw, which one waits, how it moves when a partner joins, the hover and
  focus and selected states, dark mode, and Reduce Motion.
- **Brings:** the state matrix drawn out, the motion specs, the token discipline, and the pixel
  checks against today's 52px row.
- **Approach:** builds the hardest states first (the swarm, the waiting partner of a folded
  group, a long title beside a long role), then the hero state. Draws the lone thread early, to
  prove it costs nothing.
- **Says:** visual hierarchy, density, rhythm, affordance, containment versus connection,
  facepile, stack, tree lines, indentation, disclosure, truncation, the state matrix, motion
  curves, "the 1px that makes it".

### Junior designer - "Why is the partner a row at all?"

- **Concern:** fresh eyes. Asks the naive questions that turn out to be the sharp ones, and
  brings references from everywhere, not only from coding tools.
- **Brings:** the teardown of competitors and of consumer apps (iMessage group stacks, Slack
  huddles, Chrome tab groups, Arc's split view, Gmail's conversation view, a git graph, a
  film's call sheet), the mood board, and the long list of wild ideas.
- **Approach:** sketches fast, many, and badly. Brings the idea that is "too much" so the team
  can find the part that is not.
- **Asks:** "Why do I need to see the reviewer unless it needs me?" "What if the threads just
  talked to each other in the sidebar, like a group chat?" "Why can't I see my morning, like a
  timeline?" "Isn't the branch the real thing? The threads are just the people working on it."
- **Says:** inspo, teardown, mood board, "like Arc does it", pattern library, "what if…".

### How the team works it

1. **Discover.** Teardown of 14 tools and the patterns worth borrowing (`RESEARCH.md`). The
   object map. A read of the data the controller already holds.
2. **Define.** The job stories, the problem statement above, the "how might we" questions, the
   principles, the state matrix, and the shared model in §4.
3. **Develop.** Crazy 8s, then four concepts, each pulling one lever, each pushed to its most
   convincing form with the same world and the same states.
4. **Deliver.** Four hi-fi drawings and their story pages, compared side by side against the job
   stories, with a recommendation.

**How might we…**

- …make the piece of work, not the thread, the thing you find?
- …keep a lead and its partners visibly together without doubling the list?
- …let what needs you reach you, even from a partner tucked away?
- …keep a lone thread exactly as light as today?
- …let grouping and sorting change later, without redesigning the row?
- …show the conversation between the threads, which nobody shows today?

## 4. The shared model (every direction builds on it)

**A piece of work** is one lead thread and its partners. Each direction names it in its own
words (case, family, bench, lane), and the book's comparison picks one name at the end.

- **Lead and partner.** A thread started by the user is a lead. A thread started by a session is
  a partner of that session's lead. A thread the user starts with the header's `+` in a thread's
  workspace is a partner of that thread's lead. A partner's own partners join the same lead, so
  a piece of work is always one level deep. That keeps the tree shallow.
  - **Needs:** expose `sessions.created_by` on Session as `startedBy`. Store the lead on a thread
    started from the header's `+` (`leadSessionId`), because a workspace is not proof.
- **Role.** A partner gets a short role ("review", "tests", "research"), written once by a
  Text Generation from the brief its lead gave it, as a thread's title is
  (`sessions/thread.role`). A direction may show it in place of the partner's full title, which
  mostly repeats the lead's.
- **Exchanges.** A message between two threads of one piece of work is an exchange: inputs whose
  actor is `session:<id>`. Already stored.
- **Who speaks for the group.** When one status stands for several threads, the most urgent
  wins: waiting, then failed, then working, then queued, then idle, then asleep, then away.
  Among equals, the newest activity wins. A click on the group's status opens the thread that
  speaks for it.
- **A group of one is a thread.** A lead with no partners draws exactly as today's row. Group
  chrome appears only when a second thread joins.
- **Finish together.** Marking a lead done offers to mark its partners done too, with one Undo.
  A partner can still be marked done on its own.
- **Lenses.** Grouping and sorting are a lens over pieces of work: group by project (default),
  status, machine, or nothing; sort by started, last activity, or name. The piece of work is the
  atom the lens moves. No direction may make this impossible, and each shows one other lens.
- **What stays.** The face switch, New thread with Search and the Office, Waiting on you at the
  top (a direction may redraw its rows), the Done shelf, the foot's counts, and the Assistants
  pinned at the bottom.

## 5. Principles

1. **One piece of work reads as one thing.** You can see what belongs together without reading
   every title.
2. **What needs you always rises.** A folded group, a quiet partner, a thread on another machine:
   a waiting Request reaches the surface every time, and one move reaches it.
3. **A lone thread costs nothing.** No extra chrome, no extra height, no extra word.
4. **Nothing moves under the pointer.** A partner joining, a thread working, a status changing:
   rows hold still while the pointer is in the list.
5. **Say it once.** The piece of work's name is said once. A partner is named by what it adds,
   its role and its agent, not by a title that repeats its lead's.
6. **Grouping is a lens, not a wall.** The model survives any grouping or sorting.
7. **Crew Bureau.** Color is who. State is a pose and a mark. Places get tints. Marigold means you.
8. **Cheap while idle.** No polling, no timers while nothing changes, nothing per streamed token
   (ADR 0037). Each direction says what it costs.

## 6. The fixtures

`shared/world.js` holds the one world every direction draws, on the book's morning (Tuesday 29
September 2026, 09:41). It extends `../shared/CONTENT.md` with partners:

| Project | Piece of work | Lead | Partners |
|---|---|---|---|
| webshop | Fix 3-D Secure checkout for EU cards | Claude · Opus 5.5, **waiting: Run git push?** | research (Claude, added with `+`, idle), review (Codex, working) |
| webshop | Refactor cart totals | Claude · Sonnet 5, working | tests (Codex mini, working) |
| webshop | Tidy checkout CSS · Audit checkout for screen readers | two lone threads, **one main workspace** | - |
| payments-api | Payout report for September | Codex, working | check (Claude, **waiting: Settlement or payout date?**, scratch workspace on build-box-2) |
| payments-api | Migrate payout endpoints to Result types | Claude · Opus 5.5, working, draft PR #1287 | review (Codex, idle, "3 findings, 1 blocking") |
| payments-api | Add iDEAL research | lone, idle | - |
| ops | Migrate ops dashboards | pi, **waiting: Keep the old Grafana folder?** | alerts (Claude Haiku, idle) |
| ops | Rotate staging secrets | lone, working | in the spawn state it starts "verify" (Codex mini) |
| No project | What changed in Bun 1.4? | lone, idle | - |

16 live threads: 6 working · 3 waiting · 7 idle. Ten exchanges between them. The Done shelf holds 23,
two of them pieces of work done together. The swarm adds 19 threads: 35 threads and 21 pieces of work in
view, and more behind each project's "more" row.

## 7. The states every direction draws

Each direction's `desktop.html` takes `?state=` and `?theme=`:

| State | What it shows |
|---|---|
| `everyday` | The heavy morning. The open thread is the 3-D Secure lead, waiting on you. |
| `partner` | The open thread is the 3-D Secure review (Codex). Can you tell where you are? |
| `spawn` | "Rotate staging secrets" starts its first partner. The lone row becomes a group, live. |
| `swarm` | 35 threads in view, more behind. Does it still read? |
| `done` | The 3-D Secure work is finished and put away, all three threads at once. |
| `lens` | The same world grouped by status (Needs you, Working, Quiet). Does the model survive? |

A direction adds states of its own where it needs them. Every state works in Whitehaven and
Orient Express.

## 8. The four directions

Each pulls one lever, and its story page names the lever in its first sentence. They organize by
four different things: **the crew**, **the lineage**, **the product**, and **time**.

| Direction | Folder | Organizes by | Lever |
|---|---|---|---|
| **Case Files** | `case-files/` | the crew | One piece of work, one row. The crew rides on it as faces. |
| **Lineage** | `lineage/` | who started whom | Every thread keeps its row. Kinship is drawn, not boxed, so it survives any sort. |
| **Workbench** | `workbench/` | what the work produces | The sidebar lists the work. The window seats the crew. |
| **Tracks** | `tracks/` | time | Every piece of work is a lane, and every thread a track in it. |

### 8.1 Case Files - "One case, one row"

**Lever:** the piece of work is the row. Its threads are its crew, and the crew rides on the
row as faces.

- **Noun:** a **case**, the Bureau's word: a detective agency works cases, and a case has a crew.
- **The row.** Line 1 is the case's name (its lead's title) and the status of whoever speaks for
  the case. Line 2 is the **crew strip**, then the **exchange line**:
  - The crew strip: every member's face, small and overlapping, in its pose. The lead is first.
    A partner that waits raises its hand with the marigold palm, right there on the row.
  - The exchange line: the last thing one member said to another, such as
    "review → lead: 1 finding so far".
  - A case of one is today's row, unchanged.
- **Opening a case** (the chevron, `→`, or opening any of its threads) unfolds the case file
  under the row: one short row per member with face, role, agent and status. Then the case's
  foot: branch and changes, "Add a partner", and "Close the case".
- **The huh:** you see the conversation between your agents without opening anything. The
  faces tell you who is working and who is waiting before you read a word. Hovering the
  exchange line shows the case notes: the last few exchanges, like a sequence of telegrams.
- **Calm:** a partner joining adds a face to the strip and never adds a row, so the list never
  moves.
- **Outside the sidebar:** the header's tabs become the case's crew, each tab a face and a role.
- **Lens:** a case is the atom. By status, a case sits under the status of whoever speaks for it.
- **Finish:** "Close the case" puts the whole crew on the Done shelf as one row, with one Undo.
- **Needs:** `startedBy`, the `+` lead link, roles, and the exchanges read with the session list
  (the last exchange per case only).
- **Costs:** no new process or timer. Faces are SVG already drawn elsewhere. One more line of
  text per case, updated when an exchange lands, never per token.
- **Risks the team raised:** faces seeded at random are not names (answer: the faces only say
  who is busy and who waits; the title and roles carry the names). A new noun (answer: "case"
  is the Bureau's own word, and it is honest).

### 8.2 Lineage - "Every thread keeps its row; the family is drawn"

**Lever:** do not box threads. Draw who started whom, as a line, and carry that kinship on
every row, so it survives any grouping or sorting.

- **Noun:** a **family**: a lead and the threads it started.
- **The line.** A partner sits under its lead, indented, joined to it by a thin line in the
  **lead's signature hue**. Color is who, and the lead is who started them. Like a git graph or a
  metro map, the line branches where a partner was started.
- **The partner row** is short and says what it adds: its face on the line, its role
  ("review"), its agent ("Codex"), and its status. It never repeats its lead's title. The full
  title sits in the hover card.
- **Quiet partners fold into the line.** Partners with nothing going on fold into a small knot on
  the line ("2 quiet"), the way Claude's agent teams fold idle agents. A family of four with two
  idle shows three rows.
- **The huh:**
  - **Kinship survives the lens.** Group by status, and families split across groups, yet each
    partner keeps a kin tag (a dot in its lead's hue and the lead's short name). Hover it, and
    the whole family lights up across the list.
  - **The line carries the conversation.** When a thread messages another, a bead runs along
    the line once.
- **Calm:** a partner that joins while the pointer is in the list waits as a small "+1" pip on
  its lead's line, and slides in when the pointer leaves.
- **Finish:** "Mark done" on a lead offers "with its 2 partners", and the shelf keeps the family
  together.
- **Needs:** `startedBy`, the `+` lead link, roles, exchanges. The list sorts partners under their
  lead.
- **Costs:** the line is one SVG per family, drawn on change. The bead is one CSS animation per
  exchange, and none under Reduce Motion.
- **Risks the team raised:** a tree in a sidebar can look busy (answer: one line, one hue, no
  boxes; lone threads draw no line at all). Partner rows still cost height (answer: quiet
  partners fold into the knot).

### 8.3 Workbench - "The sidebar lists the work; the window seats the crew"

**Lever:** move the crew out of the sidebar. A row is a piece of work, named by what it
produces. The crew sits in the window, where you work with it.

- **Noun:** a **bench**: one piece of work, at its branch.
- **The row.** Line 1 is the work's name: the PR's title when there is a PR, else the lead's title.
  Line 2 is what the work has produced: branch, changes (+48 −12), the PR and its checks. At the
  row's end sits the crew as a cluster of tiny pose dots, the marigold one first. The sidebar
  holds one row per piece of work, never a row per thread.
- **The crew bar** replaces the header's tabs. Each seat is a member's face, role and agent, with
  its status. `⌥1`…`⌥4` switch between them, and the seat that waits pulses once in marigold.
- **The duet.** Seat two members side by side: two transcripts in two columns. Every exchange
  between them is drawn as a bridge from the message that sent it to where it landed, so you
  read the agents' conversation like a sequence diagram.
- **The huh:**
  - You watch your agents talk.
  - The reviewer's findings are pinned beside the lead's changed files, as margin notes, so
    the review lands on the diff it is about.
  - The row tells you the product, not the chatter: "+48 −12 · 3 files · not pushed".
- **Lens:** by PR state (Not pushed, Draft, In review, Merged) as well as by status.
- **Finish:** "Finish the bench" marks the crew done, and offers it on its own when the PR merges.
- **Needs:** `startedBy`, the `+` lead link, roles, exchanges, plus two reads the app does not have
  yet: the workspace's change counts (the runner's `git diff --shortstat`, reported on change)
  and the PR's state from the GitHub Connection.
- **Costs:** the duet mounts a second transcript, which roughly doubles a thread's memory while
  it is open. The bridges are laid out once per exchange and on resize, not per token. The sidebar
  gets cheaper, because it draws fewer rows.
- **Risks the team raised:** reaching a partner takes two moves (answer: the row's crew dots are
  buttons, and `⌥`-number in the window). Pieces of work with no branch (answer: they show their
  machine, as today's row does).

### 8.4 Tracks - "Every piece of work is a lane in time"

**Lever:** time organizes the list. Each piece of work is a lane, and each of its threads a
track in it, running up to now. You see the rhythm of the work, not just its status.

- **Noun:** a **lane**.
- **The row.** Line 1 is the lane's name and the status of whoever speaks for it. Line 2 is a
  track strip over the last 90 minutes, its right edge at now, with one hairline per thread:
  - in the thread's own hue, because color is who;
  - solid where it worked, and faint where it was idle;
  - a marigold cap where it waits on you, and a check where it finished;
  - a partner's track branches off its lead's track at the minute it was started;
  - a tick joins two tracks where one messaged the other.
  - A lone thread's lane has one track.
- **"You were here."** A small notch marks when you last looked at the lane. Everything to its
  right is news to you.
- **The day sheet.** Widen the sidebar, or press `⌘⇧T`, and the lanes spread into a full day
  sheet over the main pane: a call sheet of the morning, every thread on one time axis, hours
  labelled, hover to read.
- **The huh:** you see your morning. Which work has been stuck for an hour, which partner never
  started, what happened while you were away, all without reading a word.
- **Lens:** lanes group by project, status or machine like any atom. The time axis stays.
- **Needs:** `startedBy`, the `+` lead link, roles, exchanges, plus a new read: each thread's
  activity spans (when its turns ran) for the last hours, derived from the stored stream, and kept
  live from the session updates the app already receives. It also needs the last time Rogier
  opened each thread, which the client can keep.
- **Costs:** the strips are SVG, redrawn once a minute while visible (time moves), by shifting
  one group, not by laying out the row again. A streamed token changes nothing; a turn starting
  or ending redraws one strip.
- **Risks the team raised:** hairlines are subtle (answer: they are meant to be quiet. Only now,
  marigold and the notch speak up). Data viz in a sidebar is unfamiliar (answer: line 1 is
  today's row. The tracks replace only the second line).

## 9. How we judge

Against the job stories, in this order:

1. **Find:** how fast can you point at "the review of the cart work"?
2. **Attend:** can a waiting partner ever be missed?
3. **Oversee:** in one glance, what is moving and what is stuck?
4. **Switch:** how many moves from the lead to its partner and back?
5. **Finish:** how many moves to put a piece of work away?
6. **The lone thread:** is it exactly as light as today?
7. **Calm:** does anything move under the pointer?
8. **The lens:** does it survive grouping by status?
9. **Scale:** does the swarm still read?
10. **Cost:** what does it cost while idle and per token?
11. **The huh:** would a Codex or Claude Code user stop and look twice?
