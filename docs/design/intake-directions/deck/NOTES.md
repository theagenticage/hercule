# Intake, direction A: Deck

Lever: speed per decision. Intake deals one complete decision at a time. Rogier answers with one
key or one swipe, the next card moves up, and the strip tells him how many are left and how long
they take. When the last one is answered, the page says so.

## Files

- `desktop/intake.html` (1440x900), `web/intake.html` (1280x800), `mobile/intake.html` (390x844)
- `intake.css`: the direction's own components, shared by the three pages
- `deck.js`: one extra file the brief did not ask for. It holds the fixtures, the rendering, the
  keys, the swipe, Undo, Split and the shell counts. The three pages share it because the same
  nine cards render on all three; an inline script per page would repeat about 900 lines three
  times.

Nothing outside `deck/` was changed.

## States and URLs

Every state also takes `?theme=dark`. `?d=<card id>` puts any card in focus.

Card ids today: `lead`, `android`, `breaker`, `backup`, `marta`, `webhook`, `merge`, `ssl`,
`ideal`. Card ids in the swarm: `lead`, `android`, `breaker`, `s-fix9`, `webhook`, `s-infra8`,
`s-replies20`, `s-accept14`, `s-vendor6`, `merge12`, `s-close9`, `s-release5`, `s-low22`.

| Page | URL | What it shows |
|---|---|---|
| desktop | `desktop/intake.html` | today: 9 decisions, the burning proposal in focus |
| desktop | `?state=evidence` | Space: the dossier beside the card, in place of the rail |
| desktop | `?state=swarm` | 10x: 90 decisions dealt as 13 cards |
| desktop | `?state=clear` | the deck is done: what moved, what shipped |
| desktop | `?state=panel` | 09:44: the deck in the ⌥Space panel over another app, the menu bar extra |
| desktop | `?state=shelf` | the "no action" fold open, with the Hetzner event and its fallback mark |
| desktop | `?topic=checkout` (or `infrastructure`, `customers`, `releases`) | one topic dealt |
| web | `web/intake.html` | today; the tab title reads "(9) Intake · Hercule" |
| web | `?state=evidence`, `?state=swarm`, `?state=clear` | as on the desktop |
| web | `?d=<id>` | stands for the web app's `/intake/d/<id>`; the card's foot shows that path, and the URL follows the card as you move |
| mobile | `mobile/intake.html` | today, the burning proposal in focus, every answer in the thumb zone |
| mobile | `?state=swipe` | the card dragged right, uncovering the accent answer; the haptic note "tick at the threshold" |
| mobile | `?state=held` | Start "Fix bug" just swiped; Undo for 5 seconds |
| mobile | `?state=evidence` | swipe up: the dossier as a sheet |
| mobile | `?state=triage` | the Triage face in the title: last triage, the quiet shelf, the receipt |
| mobile | `?state=swarm`, `?state=clear` | as on the desktop |
| mobile | `?state=lock` | 09:44, the lock screen with the Live Activity "4 decisions · about 1 min"; the haptic note under it |
| mobile | `?state=chat` | one decision as one Slack message, and an edited one |

The pages work too, not only their URLs. On desktop and web: ↩ takes the accent answer, 1-9 the
numbered ones, J and K move, Space opens the evidence, S splits a batch, U undoes, ? lists the
keys, Esc closes. On the phone, drag the card: right takes the accent answer, left the quiet one,
up opens the evidence.

## Components

All classes are in `intake.css`. They are placed around system classes, never instead of them.

| Class | What it is | Reuses from `system.css` |
|---|---|---|
| `.deck`, `.deck-stage`, `.deck-rail`, `.rail-section`, `.rail-foot` | the page: one stage for the card, a rail beside it | `.app`, `.main`, `.bar`, `.tabs`, `.tab`, `.section-h`, `.count` |
| `.deck-strip`, `.deck-strip-head`, `.deck-estimate`, `.deck-triage`, `.deck-pips`, `.deck-pip-*` | how many, about how long, one pip per card grouped Now / Needs a call / Today / When you can; last triage and Triage now | `.deco-num`, `.btn--sm` |
| `.deck-table`, `.deck-card` (`--bare`), `.deck-kind`, `.deck-priority`, `.deck-seen`, `.deck-title`, `.deck-gist`, `.deck-note`, `.deck-card-foot`, `.deck-link` | the decision card: kind and topic, title, gist, made from, the answers, a note from triage, Evidence | `.card`, `.bars`, `.proj`, `.ledger`, `.ans`, `.ans-desc`, `.btn`, `.btn--lg`, `.btn--quiet`, `kbd` |
| `.made-from`, `.made-from-entry`, `.made-from-count`, `.made-from-conn` | one entry per source system: its mark, what it brought, the Connection that carried it | brand marks |
| `.describe-line`, `.answer-fine` | the core's describe line in the ledger, and the producer's description as fine print | - |
| `.answer-unavailable` | an answer that cannot be taken: shown, dimmed, not clickable | `.btn` |
| `.batch-members` (`--two`), `.batch-flow`, `.batch-more` | the members of a batch, listed small inside its card | - |
| `.deck-peeks`, `.deck-peek`, `.deck-peek-kind`, `.deck-peek-title` | the next two cards tucked under the one in focus, titles only | - |
| `.deck-keys`, `.deck-help` | the key hints under the stage, and the key list on ? | `kbd`, `.pop` |
| `.moving-*`, `.held-row`, `.held-glyph`, `.held-seconds`, `.held-when` | Moving: what is running because of earlier answers, and the answer held for Undo | faces, `data-mark` |
| `.shelf`, `.shelf-*` | the quiet shelf: last triage's summary, FYI, attached, no action, the new Connection; each a fold. It uses the Moving rows' grid, so every row's text starts on Moving's text edge and the Triage face and Linear mark sit in the 24 px gutter | brand marks |
| `.receipt` | "212 events since 18:20 → 5 proposals · 2 offers · 1 unsure · 34 held", every count a link. It holds only what the shelf does not: with the shelf's 3 + 1 + 166, the counts add up to 212 | - |
| `.deck-evidence`, `.evidence-*` | the dossier: why, one excerpt per source with "Open in ...", history | `.icon-btn`, `.section-h` |
| `.deck-clear`, `.deck-clear-next`, `.deck-clear-sum`, `.shipped`, `.shipped-list`, `.shipped-row` | the clear state | `.deco-num`, `data-mark="done"` |
| `.deck-desk`, `.deck-menubar*`, `.deck-other-app*`, `.deck-panel*` | the panel state: a drawn macOS desktop, another app, the panel over it | `.glass`, `kbd`, `data-logo` |
| `.deck-web` | the deck under the web bar | web bar from `crew.js` |
| `.deck-m*`, `.deck-under*`, `.deck-swipe*`, `.deck-dock`, `.answer-glyph`, `.answer-swatch` | the phone deck: the swipe reveal, the swipe hints, every answer in the thumb zone | `.phone`, `.m-title`, `.m-answers`, `.m-ans`, `.haptic`, the tab bar |
| `.deck-sheet`, `.deck-sheet-body` | the phone's evidence and last-triage sheets | `.sheet` |
| `.deck-lock*`, `.deck-la*` | the lock screen and the Live Activity | `.haptic` |
| `.deck-chat-*` | one decision as one Slack message | - |
| `.src-x` | the fallback mark for a system with no brand mark | - |

Where `intake.css` names a system class, it only places it or sets its color in one context:

- `.deck-card .ledger`: margin and the hairline above the answers
- `.made-from-entry`, `.shelf-line`, `.evidence-source` marks: color only
- `.deck-under-right .haptic`, `.deck-lock .haptic`: color on a colored or dark ground
- `.shelf-fold > summary > .cr`, `.shelf-connection > .br`, `.deck-m-last .deck-triage > .cr`:
  placed in the shelf's 24 px gutter
- `.deck-panel .deck-strip-head .btn`, `.phone .deck-strip-head .btn`: hidden where there is no room for Triage now
- `.deck-lock .status-time`, `html[data-state="lock"] .home-ind`: the lock screen's own clock and a white home bar
- `.answer-unavailable > .btn`: opacity 0.45 and a not-allowed cursor, because `system.css` has no disabled button

## Departures

- **Departs from the pinned Intake semantics ("lead card + condensed rows") because** the lever
  is one decision at a time. Only the card in focus has detail; the next two show titles only;
  the rest are pips. The cost is plain: 1 decision is answerable without scrolling, against 3
  today. Every other card is one key away.
- **Departs from the pinned "one calm headline sentence" because** a count and a time ("9
  decisions · about 2 min") tell Rogier when he is done. The full sentence lives on as the receipt
  at the foot of the rail.
- **Departs from the pinned pulsing Now dot (label, card, topic tab) because** spec 17 allows no
  animation while idle. Now is the one red pip and the card's Urgent bars. Nothing pulses, and the
  topic tab carries no dot.
- **Departs from the pinned "What came in" rows (one per Connection) because** the brief folds
  everything that needs no answer into one quiet shelf. The shelf groups by stamp (FYI, attached,
  no action); each line names its system and Connection. No count appears in both the shelf and
  the receipt: the shelf counts what needs no answer, the receipt the events and the decisions,
  and every count opens its events.
- **Departs from the pinned made-from suffix on the phone because** 390 px has no room for it next
  to the counts. The phone card shows the system mark and the count; the Connection is in the
  evidence.
- **Departs from spec 10 §7.4 (one answer is one operation, with one core-rendered describe
  line) for batches.** "Accept all 22" takes Accept on 22 decisions: 22 `notification.act` calls,
  not one. Its describe line ("Removes label proposed from the 22 Tasks above") is a summary the
  client writes, not the core. The members list names every Task, and Split (S) deals each member
  with its own core describe line. Before a build, two things need deciding: who writes the
  summary line, and how a batch shows that some members failed.
- **Departs from spec 10 §7.4's bindable list for Merge, Reply and Close.** Plugin actions are
  not bindable yet (spec 16, open item A). Merge all 4 and Close all 9 are the brief's own
  fixtures; Reply to all 6 in the swarm is mine.
- **Departs from spec 17 ("One window", "No hidden windows") for the ⌥Space panel.** The panel is
  a second window, created on the hotkey and destroyed on Esc, never kept hidden and warm. It
  costs one more renderer process (about 18 MB empty, more with the deck) only while it is open,
  and its first card waits on a cold renderer start. To measure: process count and summed
  footprint with the panel open, and hotkey-to-first-card time. The cheaper choice that keeps
  one window: the hotkey raises the main window in a compact deck layout. CSS glass cannot blur
  another app, so a real panel needs native vibrancy, which the window server draws.
- **Departs from spec 17 for the menu bar extra "4 decisions".** Spec 17 has no menu bar item.
  It costs a tray icon in the main process, no new process. The dock badge stays on the threads
  that wait on Rogier (3), as spec 17 has it.

## Animation cost on desktop

The prototype draws no motion at all; the desktop page sets `data-motion="off"`. In a build:

- **Dealing the next card** (after ↩, a number key, J or K): the card and the peeks move up with
  one transform and opacity transition, no longer than `--dur-3`. It runs on the compositor, does
  no layout, and costs nothing at rest. It answers a key, so spec 17 allows it.
- **Pips**: the fill snaps. One class change, one paint of a small strip.
- **Undo countdown**: the seconds text changes once a second for 5 seconds after an answer, then
  the timer stops. Five tiny paints per answer, no work while idle.
- **Faces in Moving**: still. Spec 17 animates only the working face beside the open thread's
  running turn, and Intake is not a thread.
- **Evidence**: replaces the rail with no transition.
- **Panel**: macOS draws its appearance and vibrancy; the renderer does nothing per frame. Its
  real cost is the process, above.
- **Reduce motion**: everything snaps.

## One decision as one chat message

`mobile/intake.html?state=chat` shows it, following spec 12 §11.6. One card maps to one message:

| On the card | In the Slack message |
|---|---|
| kind · topic · priority · project | a context line above the title |
| title | the bold title |
| gist, made-from counts | the body |
| each ledger row | one line: **label** · describe line, the fine print as subtext under it |
| each answer | one button carrying the label only; the accent answer in Slack's primary style |
| Evidence | "Open in Hercule", a link to `/intake/d/<id>` |
| answered anywhere | the message is edited: buttons gone, one line "✓ **Start "Investigate"** - decided on the desktop" |

The open question is batches. If the client groups the 22 low-priority proposals, Slack gets 22
messages for one card, and one card is no longer one message. The batch has to exist before
delivery (triage marks the group, and the sink posts one message for it) for the one-to-one
mapping to hold.

## Counts (default state)

| Page | Buttons in view (on page) | Words in view (on page) | Numbers in view | Answerable without scrolling | Reachable without scrolling | Keys or swipes to clear |
|---|---|---|---|---|---|---|
| desktop | 6 (7) | 422 (422) | 72 | 1 of 9 | 9 of 9, with J/K | 9 |
| web | 6 (7) | 423 (423) | 72 | 1 of 9 | 9 of 9, with J/K | 9 |
| mobile | 5 (14) | 131 (139) | 17 | 1 of 9 | 9 of 9, by swiping | 9 |

Today's page, from the brief: desktop 13 buttons and 348 words in view, 3 of 9 answerable; phone
3 buttons and 133 words in view. At 10x the deck clears 90 decisions in 13 keys.

Buttons went down; words went up on the desktop. By region: the card 143, the rail 105 (Moving
40, the shelf 30, the foot 31), the sidebar 64, the strip 24, the peeks 15, the bar 13, the keys
11. The table counts words per text node and leaves out the sidebar; the regions count each
region's visible text, so the two do not add up to the same total. The rail is the first thing to
cut if words matter.

The phone shows a haptic note only where the gesture is the point: "tick at the threshold" in
`?state=swipe`, and the caption under the Live Activity in `?state=lock`. The thumb zone carries
none.

## Brief issues and guesses

- **"Both" on the Unsure card** was wrong (a Task has at most one project, spec 09). Removed; the
  card offers webshop, payments-api and Not work.
- **"Nothing waits on you."** is untrue while the sidebar shows 3 threads waiting on Rogier. The
  clear state says "No decisions wait on you."
- **Swarm, "60 proposals dealt as about 14 cards"**: Intake at 10x also holds 28 offers, 1 unsure
  and 1 breaker, so the deck deals 90 decisions on 13 cards, about 4 min.
- **"Accept the 22 low-priority proposals in Releases"** does not fit the brief's own topic counts
  (Releases has 7 proposals). The 22 span every topic: Checkout 8, Infrastructure 6, Customers 3,
  Releases 2, and 3 with no topic.
- **Swarm topic tabs** count decisions, not proposals: Checkout 19, Infrastructure 14, Customers
  44, Releases 10. The brief's 19 / 14 / 17 / 7 count proposals only.
- **Which answer is the accent answer**: spec 10 §2.4 marks Accept as the primary; the brief says
  triage's suggestion is. I followed the brief: Start X when triage suggests a workflow, Accept
  otherwise. Swipe right takes it.
- **"left = Dismiss"**: not every card has a Dismiss. Left takes the card's quiet answer (Dismiss
  or Not work). A card with no quiet answer has no left swipe; a card with no accent answer (the
  Unsure, the breaker) has no right swipe. The thumb zone always lists every answer.
- **"1-4 a numbered answer"**: with "Both" gone no card has more than 3 numbered answers. The key
  list reads "1-9, the answer with that number", because the numbers follow the card.
- **Chat buttons as "label · describe line"**: spec 12 §11.6 pins one text line per answer and
  then buttons with the label only. I followed the spec.
- **"decided on the desktop"**: spec 10 §7.3 writes the outcome line from the answer's origin
  (web, api, a channel). There is no desktop origin, so either the desktop app gets one or the
  line reads "decided in the web app".
- **Undo** holds the answer in the client for 5 seconds before it is sent. A tab closed or an app
  quit in those 5 seconds must send it, not drop it.
- **Park**, the post-v1 fourth proposal answer, fits: a fourth ledger row on desktop and web, a
  fourth thumb-zone row on the phone (checked while the Unsure card still had four answers).
- **09:44**: the panel, lock and chat states assume Rogier answered five cards on the desktop
  (the lead, the Unsure, the breaker, the backup proposal and Marta's offer), with Marta's Draft
  reply still held for Undo. That is where "4 decisions · about 1 min" comes from.
- **Run names in the clear state** ("Webhook retry backoff", "Renew status page SSL" and the
  rest) are mine, derived from the cards that started them.
- **Estimate**: 13 seconds per card plus 8 per batch, my guess.

Two things the checks flag on purpose: in `mobile?state=swipe` the dragged card leaves the frame,
and on `?d=merge` and `?d=webhook` the second peek cuts the SSL title with an ellipsis, because a
peek is one line.
