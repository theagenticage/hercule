# List and Kanban - the quiet iteration

PROTOTYPE. Round 2 of "Seeing all the work" (`../overview-directions/`). The book lives in
`index.html` beside this file; the live window is `desktop.html`; the technical proposal behind
both views is `SIGNALS.md`.

## 1. What Rogier said about round 1 (25 October 2026)

- None of the five directions work for him: **too much on the page**. The original Crew Bureau
  thread list is still better, **because it is quieter**.
- He likes the **Kanban board** (Expedition's Board).
- The overview gets three modes: **Office** (as today) · **List** · **Kanban**.
- Make the List less "out there", within the Crew Bureau book. It must work when there are
  **many** active sessions. The goal is to **declutter the user's mind**, not to add to it.
- Find ways to **cut to the core**, and to let the user **find and zoom in** on the threads that
  interest them, not only the ones that need their attention.
- The same approach for the Kanban.
- The open question none of round 1 answered: **how do we actually know how far along a session
  is, and where it is working?** There is no code map. We need a technical answer.

## 2. The question

> How does a list of 70 sessions stay as quiet as today's list of 15, while letting Rogier get to
> any one of them, or any group of them, in a moment? And what can each row honestly say about
> progress and place, from what Hercule really observes?

## 3. Principles

1. **Quiet wins.** At rest a row is a title, one muted line and one mark. Nothing else earns a
   place unless it carries the one fact that matters for that row.
2. **Summarise, then unfold.** The default view answers "what is going on" with a few summary
   lines, not with more rows. Detail arrives when you ask for it.
3. **Find in two keystrokes.** Type anywhere to filter. Any thread is reachable by what it is:
   its title, project, branch, folder, model or who started it.
4. **Zoom, not scroll.** Zooming in shows more about fewer things: a project, then its threads,
   then one thread's progress and place. Zooming out gives the calm view back.
5. **Interest, not only attention.** The user can follow threads, and see only what they started
   or what they follow. Waiting on you still rises, but it is one lens of several.
6. **Only real signals.** Progress and place come from what Hercule observes (SIGNALS.md). Agents
   keep no plan today, so a plan exists only where Hercule's own progress tool was used. When a
   signal is missing, the row says less, never guesses more.
7. **Nothing moves under the pointer** (#626).
8. **Crew Bureau, unchanged.** Same tokens, same type ramp, same row anatomy as today's sidebar
   and the book's Office list. Color is who; marigold means you.

## 4. The window

- The sidebar stays as it is today. The overview opens in the main pane (the sidebar's Office
  button, ⌘⇧O), with a three-way switch: **Office · List · Kanban**.
- **Office** is today's Office, untouched.
- **List** and **Kanban** share one find bar, one set of lenses, one selection, and one **peek**
  panel: select a thread and the panel shows its progress and place in full, without opening it.

### The find bar (List and Kanban)

- One field: "Find a thread". Typing anywhere in the overview focuses it.
- Plain words match titles, branches, folders and models. Tokens narrow further:
  `project:webshop`, `in:src/checkout`, `model:codex`, `on:build-box-1`, `by:me`, `is:waiting`.
- Four lenses beside it, as quiet text tabs: **All · Following · Mine · Needs you**.
  - **Following**: threads the user follows (the phone already says Followed Thread). Follow with
    `F` or from the peek panel.
  - **Mine**: threads the user started (`startedBy: user`), not the partners agents started.
- A filter never hides a thread that waits on you without saying so ("1 waiting thread hidden").

### The peek panel

What one thread is doing, how far along, and where, in one column at the right:
progress (plan or milestones), place (folder, files, branch, machine), the last check, the crew,
the ask with its buttons, and Open thread. It is the "zoom in" on one thread.

## 5. The List: three variants, all quiet

Each draws the same 70 sessions. Each keeps Waiting on you on top.

1. **Rows** - today's sidebar row, full width. Grouped by project; line 2 becomes the **digest
   line** ("Verifying · 3 of 7 · src/checkout"). A project folds to one roll-up line ("webshop ·
   14 working · 1 needs you"). Quiet threads fold into "9 resting".
2. **Table** - one 36px line per thread, quiet aligned columns: status mark, thread, progress,
   where, machine, age. Sortable. For scanning many rows fast, as in Linear.
3. **Outline** - zoom levels. Level 1: one line per project. Level 2: its threads. Level 3: one
   thread's digest and crew. `→` zooms into the focused line, `←` zooms out. At rest the whole
   overview is five lines.

## 6. The Kanban: two variants, all quiet

Cards are small and calm: a face, the title, one muted line, the age. The board scrolls per
column; within a column, cards group by project under small headers; resting cards fold to a
count. Swimlanes by project are a toggle.

1. **By state** (the default) - Needs you · Working · To review (a turn ended you have not read)
   · Resting · Done today. Every column comes from facts Hercule has, or will have with one small
   field (the last-seen mark).
2. **By phase** - Exploring · Changing · Verifying · Shipping, with Needs you as a narrow lane on
   the left and Resting folded on the right. The phase comes from what the agent is doing now
   (SIGNALS.md). Cards move when the work does. Changing and Shipping are reliable; Exploring and
   Verifying are good but not certain, so every card can say why it sits where it does.

## 7. The world

A heavy morning: the book's 16 threads, the swarm's 19, and enough more for about 70 live
sessions across webshop, payments-api and ops, each with the signals SIGNALS.md defines. It lives
in `shared/heavy-world.js`.

## 8. How we judge

1. **Quiet:** is the default view calmer than today's sidebar, at 70 sessions?
2. **Core:** in three seconds, can you say what is moving, what is stuck and what needs you?
3. **Find:** how many keystrokes to "the review of the cart work"?
4. **Zoom:** how many moves from the whole morning to one thread's progress, and back?
5. **Honest:** does every progress or place hint trace to a real signal?
