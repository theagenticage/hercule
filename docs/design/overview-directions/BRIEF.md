# Seeing all the work - the team exercise and five briefs

PROTOTYPE. The brief behind five directions for how Hercule shows all the work in flight: the
sidebar's threads, the 3D Office, and one new view per direction. Drawn in Crew Bureau 2. The book
(`index.html` beside this file) tells the story; each direction has a story page
(`<direction>/index.html`) and a live window (`<direction>/desktop.html`).

## 1. The question

The sidebar is the only place where Rogier sees what work is going on. It was built to navigate:
find a thread, open it. Every month it is asked to do more. There are 40 threads in five projects
on a normal day, leads start partners, assistants start threads, workflows run at night, and #828
squeezed groups of threads into one row with crew dots. It is better than it was. But a 272px
column has room for a title, a status word and a machine, and nothing else.

The 3D Office is the only place where Rogier can see every session at once, and he uses it to show
people, not to work. The Office shows **how many** agents there are. It does not show **what** each
one works on, **how far** it is from its goal, or **which ones belong together**: every thread of a
project sits in the same room at the same kind of desk.

The Crew Bureau 2 book drew the Office with a **List | Floor** switch: the 3D bean colleagues are
just one way of looking at a large amount of work, and a list is another. Round one of the sidebar
book drew Tracks, whose **day sheet** laid every thread on one clock. Both ideas were left on the
shelf.

> **How might Hercule give Rogier a true overview of all the work in flight, in three modes that
> look at the same work three ways: the Office, a list of threads, and one new view, so he always
> knows what is happening, what it means, and what will happen next?**

Constraints from Rogier (24 October 2026):

- Up to five directions, each radically different in how it organizes the threads.
- Each direction has **three modes**: the **Office** (3D, with a new concept), **Threads** (a list,
  organized however the direction likes), and **one view of its own**, as the day sheet was for
  Tracks, a different idea per direction.
- Hi-fi, in Crew Bureau, paying homage to the book. New atoms are welcome when they serve the UX.
- Intuitive to someone who uses Claude Code, Codex or T3 Code, and still makes them stop and think
  "huh, why didn't anyone think of that?"
- Moonshots are welcome. A direction may need data the model does not hold yet, and may change other
  parts of the app. It says plainly what it needs.
- Rogier reviews on his phone, over the tailnet.

## 2. What we know

**The data** (checked 24 October 2026; see the research notes in the book):

- A Session has `kind` (thread, agent, run, assistant), `title`, `role`, `status` (queued,
  starting, idle, busy, exited), `openRequests`, `usage` (tokens; Codex reports none),
  `toolCalls`, `createdAt`, `lastActivityAt`, `workspaceId`, `runnerId`, `projectId`, `done`.
- **Lineage is stored but hidden.** `sessions.created_by` (`user` or `session:<id>`) exists in the
  database and is not on the contract. Who started whom is free.
- **Progress is recorded but not read.** A Claude todo list or a Codex plan is a transcript item
  kind (`plan`). Nothing reads it into a number.
- **Missing:** a Session has no branch (it is on the Workspace), no PR state, no diff stats, no
  "busy since", no end reason, no current-activity line (spec 18 turned that down for the phone,
  for cost), and no link to a Task (spec 02 lists `taskId`; the contract does not have it).
- **Edit Overlap** already observes which files each session edits (best effort, spec 19 §4.1).
- **GLOSSARY.md** gives the sessions of one workspace **no noun** on purpose ("bench, crew, piece of
  work" are on its Avoid list). A direction that needs a noun for a group must propose one and say
  why.
- **Office Map** is already a glossary word: "a bureau, a tower and a cave are different office maps
  of the same Office". Four directions here are new Office Maps.

**The sidebar today** (spec 17 §The sidebar, #828): Threads | Hercule switch; New thread, Search,
Office; Waiting on you (3, then "n more"); projects, newest started first, five rows each and
"n more"; a row is one workspace's threads, 52px, title and status word, then provider mark and
branch or machine, with up to three crew dots that unfold into 32px lines; the Done shelf; the
Assistants; the foot's counts.

**The Office today** (spec 17 §The Office): three.js, the Bureau map. One room per project in a row
along the Gallery, Triage, the Lounge, Your Office and the Lobby in front, the Secretariat for
assistants, the Café des Égarés across the street for threads with no project. Each session is a
bean at a desk; a waiting bean queues at your desk with its hand up; idle beans rest in the Lounge.
Name tags by distance, a dossier card on click. It draws nothing while hidden and caps at 30 fps
when only ambient life moves. It does not show progress, current activity, lineage, runs beyond a
bench, history, or the future.

## 3. The design team exercise

How a full team would take this on: who sits at the table, what each person worries about, what
they bring, how they work, and the words they use to frame the problem.

### Product owner - "What is the overview hired to do, and will Rogier open it on a Tuesday?"

- **Concern:** the Office is a showpiece. A mode that is only opened to impress people is a
  screensaver. Every mode must earn a daily habit, or be cut. The sidebar must stay a fast
  navigator; the overview is a second place with its own jobs, not a bigger sidebar.
- **Brings:** the job stories, the measures, the scope line between "drawing" and "ticket", and a
  veto on nouns that do not pay for themselves.
- **Approach:** writes the jobs first, then asks each direction for one sentence: "Rogier opens this
  mode when ___." Insists each direction lists its data asks, so a moonshot can be cut down to a
  first slice without losing its idea.
- **Says:** jobs to be done (JTBD), job story, north-star measure, time to attend, time to find,
  return briefing, habit loop, mode adoption, walking skeleton, first slice, moonshot, kill
  criteria, opportunity cost, scope creep.
- **Asks at kick-off:** "When Rogier comes back from lunch, how long until he knows what changed?
  Today it is opening threads one by one. What is it in each direction?"

**Job stories** (every critique checks against these):

1. **Attend.** When something needs me, I want to see it and answer it in one move, wherever it is.
2. **Oversee.** When I glance at the overview, I want to know what is moving, what is stuck and what
   is done, without reading every title.
3. **Gauge.** When I look at a piece of work, I want to know how far it is from done.
4. **Catch up.** When I come back after being away, I want to know what changed, in the order it
   matters.
5. **Anticipate.** When I plan my next hour, I want to know what will need me and when.
6. **Find.** When I want to get back to something, I want to find it by what it is.
7. **Show.** When I show someone Hercule, I want them to understand what my agents are doing.

### Lead designer - "One idea per direction, told three ways."

- **Concern:** five directions that are different in kind, not in detail. Each direction is a
  **world** with one organizing idea, and its three modes tell the same idea three ways: precisely
  (Threads), spatially (Office), analytically (its own view). If the three modes of a direction do
  not share an idea, it is three features, not a direction.
- **Brings:** the concept, the metaphor, the principles, and the critique. Homage to Crew Bureau:
  color is who, state is a pose and a mark, places get tints, marigold means you, the beans, the
  Art Deco of the 1930s.
- **Approach:** a double diamond. Diverge wide (crazy 8s round per person, then the idea wall),
  cluster by **axis** (what a direction organizes the work by), converge on five axes that do not
  overlap, then push each to its most convincing form with the same world and the same states.
- **Says:** the big idea, the axis, the lever, through-line, world-building, signature moment, hero
  shot, metaphor, design principles, coherence, "one idea, three lenses", the huh test, on brand.
- **Asks:** "Finish the sentence: in this direction, the work is organized by ___, and the Office
  shows it as ___."

### UX expert - "Three coordinated views of one model, and what the eye does in three seconds."

- **Concern:** mode error and lost context. The three modes must be **coordinated views**: the same
  selection, the same filters, the same counts; switching keeps your place (the thread you selected
  in the list is the bean the camera flies to). And the levels of **situational awareness**: today
  the sidebar gives perception (status words) and the Office gives a headcount. Nothing gives
  comprehension (what it means: progress, risk) or projection (what will happen: when it will need
  me). Each direction must reach the second or third level on its axis.
- **Brings:** the object map, the state matrix, the three-second test, a first-click test, the
  return test ("you were away 40 minutes: what changed?"), and accessibility: the 3D mode always has
  a list equivalent, keyboard navigation and Reduce Motion.
- **Approach:** checks every direction against the edge cases: a lone thread, a team of ten, a
  partner on another machine, two strangers in one main workspace, a swarm of 40, a thread with no
  goal (a question), a run, an assistant, and something waiting while folded away.
- **Says:** mental model, coordinated multiple views, brushing and linking, Shneiderman's mantra
  (overview first, zoom and filter, details on demand), situational awareness (perception,
  comprehension, projection), glanceability, pre-attentive attributes, semantic zoom, focus plus
  context, spatial memory, landmarks, change blindness, peripheral awareness, calm technology,
  interruption cost, information scent, mode error, stable sort, Fitts's law, Hick's law.

### Senior designer - "Does it read at 13px and at 1,000 metres?"

- **Concern:** craft at real density in all three modes. The row at 272px and 52px. Name tags that
  collide in 3D. A scene that reads at 1440x900 and on a phone. Camera choreography that never
  loses the user. Transitions between modes that keep **object constancy**: a row becomes its bean,
  a bean becomes its card. Both themes, Reduce Motion, the swarm.
- **Brings:** the state matrix drawn out, motion specs, token discipline, label systems (leader
  lines, clustering, level of detail), lighting and materials from the tokens.
- **Approach:** draws the hardest state first (the swarm, the folded waiting partner, a long title
  beside a role), then the hero shot. Draws the lone thread early, to prove it costs nothing.
- **Says:** visual hierarchy, density, rhythm, object constancy, shared-element transition, hero
  state, state matrix, level of detail (LOD), label collision, leader line, establishing shot,
  dolly, tilt-shift, diorama, silhouette, "the 1px that makes it".

### Junior designer - "Why do all the beans sit in one room?"

- **Concern:** fresh eyes. Asks the naive questions that turn out to be the sharp ones, and brings
  references from games and the world beyond software.
- **Brings:** the teardown and the mood board: The Sims (thought bubbles, needs bars), Fallout
  Shelter and Tiny Tower (the cut-away building), SimCity data views, RTS minimaps and "your base is
  under attack", Mini Metro, CodeCity and Gource (code as a city, history as a movie), air traffic
  control flight strips and the holding stack, the Tour de France stage profile, a newspaper front
  page, a newsroom's budget meeting, a kitchen's ticket rail, a station departure board, an org
  chart, a kanban board that moves itself.
- **Asks:** "Why do all the beans sit in one room?" "Why can't the office show me where they are in
  the code?" "What if I could rewind the office?" "Why does the office look the same at 9 and at
  5?" "Why don't they walk over when they talk to each other?" "What if they were planes waiting to
  land?" "Can it tell me what will need me after lunch?"
- **Says:** inspo, teardown, mood board, "what if", "like X does it", game feel, juice, HUD,
  minimap, "readable like a game".

### How the team works it

1. **Discover.** What the data holds (§2), what the Office and the sidebar do today, a teardown of
   games and tools, Rogier's own sidebar on a heavy day.
2. **Define.** The job stories, the question, the "how might we" list, the principles, the
   three-mode contract (§4).
3. **Develop.** Crazy 8s per person; the idea wall (§6); cluster by axis; pick five axes that do not
   overlap; one direction per axis, each with its Office Map and its own view.
4. **Deliver.** Five hi-fi live windows and five story pages on one shared world, compared against
   the job stories.

**How might we...**

- ...make the Office legible: what each bean works on, and how far along it is?
- ...let the overview see the future, not only the present?
- ...tell Rogier what changed while he was away, in the order it matters?
- ...keep a lone thread exactly as light as it is today?
- ...make three modes feel like one place, not three features?
- ...let the overview carry 40 threads today and 200 next year?

## 4. The three-mode contract (every direction builds on it)

- **One overview, three modes.** The overview is a place in the window (⌘⇧O, the sidebar's Office
  button). Its top bar holds a three-way switch: **Office · Threads · <the direction's view>**.
  Each direction may name its modes, but "Office" and "Threads" stay recognisable. The switch is
  also reachable by keyboard.
- **The sidebar is the Threads mode, folded.** The sidebar's list is organized by the same idea as
  the Threads mode, at 272px. The Threads mode is the same list at full width, with room for
  detail. A direction says what the sidebar does while the overview is open.
- **Coordinated views.** Selecting a thread in one mode selects it in all three. Switching modes
  keeps the selection (the camera flies to the selected bean). Counts agree everywhere.
- **Waiting on you always rises,** in every mode, and one move answers it.
- **A lone thread costs nothing** in the list: no extra chrome, height or word.
- **Nothing moves under the pointer** in the list (#626). Changes wait until the pointer leaves, or
  arrive as a pill ("3 new").
- **Cheap while idle** (ADR 0037). The Office draws only while visible, caps at 30 fps for ambient
  life, and nothing anywhere changes per streamed token. Each direction says what it costs.
- **Honest data.** Codex reports no usage: say "not reported", never invent a number. A prediction
  is shown as a prediction.
- **Crew Bureau.** Color is who; state is a pose and a mark; places get tints; marigold means you.
  The beans are the real Office's beans.

## 5. Principles

1. **One idea, three lenses.** A direction's three modes organize the work by the same thing.
2. **Comprehension, not just perception.** Every mode answers "what does it mean" on its axis, and
   at least one mode answers "what happens next".
3. **What needs you always rises.**
4. **The lone thread costs nothing.**
5. **Nothing moves under the pointer.**
6. **The Office tells the truth.** Every visual in 3D maps to a fact: if the scenery were stripped,
   a chart would remain.
7. **Calm by default.** The overview is peripheral until something needs you; marigold is spent only
   on you.
8. **Cheap while idle.**

## 6. The idea wall

Crazy 8s, clustered by axis. The five picked are in bold; the rest stay on the wall for later.

| Idea | Axis | Fate |
|---|---|---|
| **Expedition**: routes up a mountain, rope teams, base camp | progress | picked |
| **Control Tower**: flights, the holding stack, landing slots, radar | attention, the future | picked |
| **Atlas**: a city of the code, territories, a transit map of branches | where in the code | picked |
| **Gazette**: the morning paper, an Office you can rewind | news, the past | picked |
| **The Firm**: a cut-away building, a room per team, the org chart | who works for whom | picked |
| Conservatory: each piece of work a plant that grows, wilts and blooms | growth | merged into Expedition: progress is easier to read as altitude than as leaves |
| The Pass: a kitchen's ticket rail, orders called by the chef | attention | merged into Control Tower's strips |
| Departures board: split-flap rows of every thread's next event | the future | became Control Tower's arrivals board |
| Peloton: all work as riders on one stage profile | progress | dropped: one shared track hides each goal's own route |
| Orrery: you are the sun, projects are planets, agents orbit closer as they need you | attention | dropped: beautiful, but radius already carries the Radar |
| Score: every thread a staff, tool calls as notes, a playhead at now | time | dropped: the day sheet already owns time looking back |
| Factory: conveyors move work between stations | flow | merged into Expedition's Board |
| Constellation: a force graph of threads, files and messages | relations | dropped: unstable layout breaks spatial memory |
| Trading floor: a ticker of every event, prices are tokens | cost | dropped: makes noise the main event |
| Console: a voxel office, pixel-art beans | style | dropped: a style, not an idea |
| Concierge: an assistant receptionist who walks you to whoever needs you | attention | kept as a detail for any Office |

## 7. The five directions

They organize the work by five different things: **progress**, **attention**, **territory**,
**news**, and **delegation**. Each brings a new Office Map (or a new layer on the Bureau) and a
view of its own.

| Direction | Folder | Organizes by | Threads mode | Office | Its own view |
|---|---|---|---|---|---|
| **Expedition** | `expedition/` | how far from done | Routes | the Range | The Board |
| **Control Tower** | `control-tower/` | when it will need you | Strips | the Aerodrome | Radar |
| **Atlas** | `atlas/` | where in the code | Territories | the City | Lines |
| **Gazette** | `gazette/` | what changed since you looked | The Wire | the Bureau, rewindable | Front Page |
| **The Firm** | `the-firm/` | who works for whom | Chain of command | the Dollhouse | Org Chart |

### 7.1 Expedition - "Every piece of work has a summit"

**Axis:** progress. **The question it answers:** how far is each thing from done, and what is
stuck?

- **The idea.** Every lead thread has a **goal** with a **summit**: its definition of done ("PR
  merged with CI green", "Report delivered", "Question answered"), written by a Text Generation from
  the first prompt and editable. Its **route** is the plan the agent already keeps (Claude's todo
  list, Codex's plan), and its last **camps** are checks Hercule can see itself: tests pass, review
  clean, PR open, CI green, merged. A goal is a **Task** (a unit of human intent): this direction
  links threads to Tasks, as spec 02 always meant to.
- **Threads mode: Routes.** Today's row, with line 2 replaced by the **route line**: a hairline from
  base to summit, a tick per camp, filled in the thread's hue up to where it is, the bean's head at
  its position, partners roped beside it as dots, and a marigold flag where it waits on you. The
  status slot gives "camp 4 of 7" or an ETA. A route that has not moved in 30 minutes gets a small
  cloud: "no progress in 34m". A route that grows says so: "+2 camps".
- **Office: the Range.** Each project is a mountain massif in its tint; the Bureau sits in the
  valley as **base camp**, with Your desk in the lodge. Each goal is a route up its project's
  mountain, with tents at its camps. A lead and its partners climb as a **rope team**. Altitude is
  progress: you see how far up each team is. A waiting team plants a marigold flag and waves; a
  stuck one sits under a cloud; failing CI is weather; a summit gets a flag. In the dark theme the
  climbers wear headlamps.
- **Its own view: The Board.** A kanban board that moves itself. Columns are the stages every coding
  journey passes through: Scoping, Building, Proving, Reviewing, Shipping, Landed. Cards move when
  signals arrive (the first edit, the first test run, a review partner starting, a PR opening, CI,
  the merge), never by hand. Each column shows its count and the median time spent in it; a
  bottleneck callout names the column where work piles up ("Reviewing holds 4. 3 of them wait on
  you."). A cumulative flow strip along the bottom shows the morning.
- **The huh:** a progress bar that is not a lie: it is the agent's own plan plus checks Hercule can
  see. And a mountain range where you can point at what is stuck.
- **Needs:** threads linked to Tasks; the summit text; the latest `plan` item per session read at
  each turn end into `{done, total, current}`; observed checks (test runs from tool calls; PR and CI
  from the GitHub Connection; the merge); a stage classifier (rules on tool calls and partner
  roles); `startedBy` for rope teams.
- **Costs:** route lines redraw at a turn's end, never per token. The Range is a few terrain meshes
  plus the Bureau's own beans; render on demand.
- **Risks:** plans change and progress goes backwards (show it honestly: the summit moves, "+2
  camps"); a question has no route (its summit is "answered", a one-camp route); mountains may feel
  like a gimmick (strip the scenery and the altitude is still a true chart).

### 7.2 Control Tower - "Every turn is a flight, and you are the tower"

**Axis:** attention, and the future. **The question it answers:** when will each thing need me,
and can I choose when?

- **The idea.** A **flight** is a Turn (glossary: from an input until the agent goes idle). Your
  message is the take-off; working is cruising; an open Request is **holding**, circling until you
  clear it; the turn ending is the landing; a result you have not read yet is **on stand**; idle is
  parked; Done is the hangar. Hercule predicts each flight's **ETA**: when it will next need you.
- **Threads mode: Strips.** The list is a flight-strip board in bays: **Holding** (needs you now,
  the ask and its answer buttons on the strip, oldest first), **Approach** (will need you within
  about 15 minutes, sorted by ETA, "~4m"), **Cruising** (working, "airborne 22m"), **On stand**
  (finished a turn you have not read), **Parked**, and the **Hangar** (Done). A strip has its
  project's tint as a tab, a short call sign from its title (WS·3DS), the title, the ask or ETA,
  and its crew as dots. Strips change bay only when the pointer is outside the board.
- **Landing slots.** "Hold everything that is not urgent until 10:30", or "land every 20 minutes":
  Rogier chooses when agents may interrupt him. Requests queue silently in Holding, the badge reads
  "next slot 10:00 · 3 holding", and anything marked urgent still comes through. Agents keep
  working; Rogier keeps his focus.
- **Office: the Aerodrome.** The Bureau becomes an Art Deco airport of the 1930s: the terminal and
  its control tower (your desk is in the tower cab), a hangar per project in its tint, a runway and
  an apron. Each thread is a small plane with its bean as pilot. Cruising planes fly lazy loops over
  their hangar; waiting planes join the **holding stack**, circling the tower at stacked heights,
  oldest lowest, with a marigold beacon; planes predicted to need you soon line up on the approach;
  a finished turn lands and taxis to its stand; Done planes roll into the hangar. A run is a mail
  plane on a fixed route with a stop per step. Clearing a Request makes the plane land.
- **Its own view: Radar.** A round scope with you at the centre. Rings are time until a thread needs
  you (now, 5m, 15m, 1h, later); sectors are projects; blips are threads with a short trail. Holding
  blips sit on the centre ring and pulse marigold. When three arrivals fall within five minutes, a
  conflict alert offers to stagger them. The sweep turns only while the view is visible, and not at
  all under Reduce Motion. Beside it, an **arrivals board** lists the next ten ETAs.
- **The huh:** an agent tool that predicts its own interruptions, and lets you schedule them.
- **Needs:** "busy since" on a Session; an ETA estimate per busy session (plan progress plus the
  history of turn lengths per agent and model, as a range); a per-thread "result read" marker; call
  signs (derived from titles); landing slots (a user setting that batches desktop and phone
  notifications, with an urgent bypass).
- **Costs:** the sweep is one compositor-only rotation while visible; ETAs are recomputed at turn
  events and count down once a minute. Flying planes animate continuously while the Office is
  visible, so the Aerodrome parks every plane under Reduce Motion or on battery.
- **Risks:** predictions are wrong (show ranges, learn per agent, never claim certainty); moving
  strips (they move only when the pointer leaves); the metaphor is cute (strip it and the bays are
  Now, Soon, Later).

### 7.3 Atlas - "Your agents, on the map of your code"

**Axis:** territory. **The question it answers:** where in my code is everyone working, and will
they collide?

- **The idea.** A thread lives where it works: the **area** of a repository (a folder or module) it
  edits most, derived from the edits Hercule already observes for Edit Overlap. Two threads in one
  file are visible **before** they become a merge conflict.
- **Threads mode: Territories.** Project, then area (webshop › src/checkout, src/cart, styles),
  then threads. Line 2 says the file a thread is in now ("payment.ts") and its diff (+48 −12). An
  area header carries a heat bar (edits today) and a crossing badge when two threads share a file:
  "2 threads in payment.ts". A minimap at the top of the sidebar is a treemap of the code with a dot
  per agent; a click filters to an area.
- **Office: the City.** Each repository is a city, as in CodeCity: folders are districts, files are
  buildings (height is size), today's edits light the windows. Beans walk to the buildings they
  edit, scaffolding rises where code is being written, a crane stands over a big refactor, and a
  marigold ring marks a building two beans share. The Bureau is the town hall on the square: a
  waiting bean walks there to ask you. A thread that only reads (research) sits in the library.
- **Its own view: Lines.** A transit map of every branch heading for main. Each branch is a line in
  its thread's hue; stations are commits, test passes, the PR, the review, CI; **crossings** are
  files two branches both change, predicted merge conflicts from a dry-run merge. On the right, a
  suggested landing order: "1. Tidy checkout CSS, ready, no crossings. 2. Refactor cart totals,
  land before 3-D Secure, they cross at cart.ts."
- **The huh:** a merge forecast across every agent's branch, and an Office where you can see two
  agents about to collide.
- **Needs:** files edited and read per session (the edit watch, best effort, spec 19 §4.1); areas
  derived by folder; the repository's file tree with sizes (the runner reads it once per workspace
  and on change); diff stats per workspace; a dry-run merge between branches on the runner when a
  branch moves.
- **Costs:** the city is instanced boxes built once per repository and updated on edit events, not
  per token. The merge forecast runs on the runner only when a branch moves.
- **Risks:** big repositories (level of detail: districts fold into blocks until you zoom in);
  threads that do not edit (the library); the edit watch is best effort (the City says so).

### 7.4 Gazette - "The morning paper of your agents"

**Axis:** news, and the past. **The question it answers:** what happened while I was not looking,
and what matters?

- **The idea.** Every thread keeps a **since you looked** mark (kept per user, synced across
  devices). Every turn ends with a one-line **headline** written by a Text Generation, the way a
  title is. The overview is a newspaper of your work, and the Office remembers.
- **Threads mode: The Wire.** Rows read like mail: a thread with news since you looked is bold with
  an ink dot, and its line 2 is its headline ("Tests pass now. Wants to push."), not its machine.
  Sections: Needs you, News (newest first), Quiet. Keyboard triage as in mail: J and K walk the
  stories, E marks Done, S snoozes until something new happens. **Catch up** steps through every
  story in the main pane: what changed, the diff, the message that matters. New stories arrive as a
  "3 new" pill, never under the pointer.
- **Office: the Bureau, rewindable.** Today's Bureau with three new layers:
  - **Thought bubbles** over working beans: what each is doing now, in four words ("reading
    payment.ts", "running the tests"), from the latest tool call; and a paper plane flies from desk
    to desk when one thread messages another.
  - **Desks remember the day:** a paper stack grows with the diff, sticky notes for findings, a
    small cup for a merged PR, a red folder for a failure.
  - **The time dial:** scrub from 07:00 to now and the Office replays the morning; "While you were
    away" plays the last 40 minutes at 30x with captions.
- **Its own view: Front Page.** "The Bureau Gazette", morning edition, 09:41: a lead story (the
  outcome that matters most), a section per project, a "Needs your signature" box with the
  Requests and their buttons, "In brief", the morning's figures (tokens, tests run, PRs; "usage not
  reported" for Codex), corrections (failures), the weather (the fleet), and tomorrow (scheduled
  runs). Every story links to its thread. An edition is printed when you come back after 30 minutes
  or on demand; old editions are kept.
- **The huh:** you come back from lunch, and the first thing you see is a newspaper written about
  your morning.
- **Needs:** a per-user last-seen mark per thread; a headline per turn (Text Generation at turn
  end); a current-activity line per busy session, read only while the Office is visible; the
  morning's turn history for the replay; an edition (one Text Generation over the headlines).
- **Costs:** one cheap Text Generation per turn end and one per edition; the replay reads the
  history once per scrub; thought bubbles change per tool call, only while visible.
- **Risks:** summaries can be wrong (each headline links to its source); unread can feel like email
  guilt (only Needs you is counted; Quiet is not a debt).

### 7.5 The Firm - "You run a firm of agents"

**Axis:** delegation. **The question it answers:** who is working for whom?

- **The idea.** Rogier's agents already form an organization: he starts leads, leads start
  partners, assistants start threads, workflows run shifts. Who started whom is stored
  (`sessions.created_by`). A **team** is a lead and everyone it started, wherever they work. This is
  lineage, not the workspace, so it is not the noun GLOSSARY.md refuses; the direction proposes
  "team" as a new glossary word.
- **Threads mode: Chain of command.** A tree with Rogier at its root ("6 teams · 19 sessions"),
  then teams: the lead's row with a face pile, the team's size and its roles ("lead · review ·
  tests"); partners indented under it, named by role ("review · Codex"); assistants as managers with
  the threads they started; workflows as departments with their runs. The tree folds to leads only.
  A team row speaks with its most urgent member's voice. **Stand-up:** one key asks every member of
  a team for a one-line status, and each answers on its own row.
- **Office: the Dollhouse.** The Bureau cut open as a tall Art Deco building seen from the front,
  like a doll's house: one floor per project in its tint; one **room per team**, sized by headcount
  (a single office for a lone thread); a door plaque with the team's goal, a whiteboard with its
  plan and ticks, a door light in the team's status; partners walk to the lead's desk when they talk.
  Your office is the penthouse; the brass lift brings waiting beans up to you. The café is in the
  basement, the assistants have the mezzanine, and runs work the ground-floor line. The camera rides
  up and down like the lift, which suits a phone held upright.
- **Its own view: Org Chart.** A live organogram: Rogier at the top, leads and assistants below,
  partners below them, runs as departments. Cards carry face, role, model, status and time; lines
  are "started by", and a message between two threads travels its line. Hover a card to light its
  chain of command. Tokens roll up the tree ("this team used 2.1M tokens"). A span-of-control hint
  appears when one lead manages eight.
- **The huh:** the answer to "why do all the beans sit in one room": every team has its own room,
  and you can see the whole firm on one page.
- **Needs:** `startedBy` on the Session (stored, not exposed); threads an assistant starts recorded
  the same way; a team-level message (to the lead or to all); stand-up (one model call per member,
  only on demand).
- **Costs:** the tree is cheap. The Dollhouse reuses the Bureau's props; whiteboards are canvas
  textures redrawn when a plan changes.
- **Risks:** deep trees (the list keeps two levels; deeper lineage shows in the hover card); a team
  across projects (the room is on the lead's floor, the partner wears a visitor badge); the org
  chart can feel corporate (the Firm speaks in the Bureau's 1930s voice).

## 8. The fixtures

Every direction draws the same world: the book's morning, **Tuesday 29 September 2026, 09:41**, as
`../sidebar-directions/shared/world.js` holds it (16 live threads in webshop, payments-api and ops;
3 waiting on you; partners; exchanges; the Done shelf; the run "Ship release v2.15" waiting at its
publish step; the assistants Ada, Milo and Juno), extended by `shared/world-plus.js` with what these
directions read: plans, stages, ETAs, files and areas, headlines and last-seen marks, lineage, the
morning's turn history, and runs.

## 9. The states every direction draws

Each `desktop.html` takes `?mode=` (office, threads, or its own view's id), `?state=` and
`?theme=` (whitehaven, orient-express).

| State | What it shows |
|---|---|
| `everyday` | The morning. Three things wait on you. |
| `open` | A thread is open (the 3-D Secure lead); the sidebar sits beside it. |
| `swarm` | 35 threads in view and more behind. Does each mode still read? |
| `away` | Rogier comes back at 09:41 after 40 minutes away. What changed? |

A direction adds states of its own for its signature moments.

## 10. How we judge

Against the job stories, in this order: Attend, Oversee, Gauge, Catch up, Anticipate, Find, Show.
Then: the lone thread, calm, the swarm, the cost, and the huh (would a Codex or Claude Code user
stop and look twice?).
