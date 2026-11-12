# PROTOTYPE, throwaway: the model behind the Inbox lifetimes variants

Written by session 501370b2 (Opus) and amended with session f38e3c8b (Fable)
on 2026-11-10. Both sessions build their variants on this table and on
`world.ts`, whose `KINDS` table is this one in code.

## The question

Rogier, 2026-11-10: the page has to show two things that pull against each
other:

- External Entities that live long, such as Linear tickets;
- things that happen and do not live long.

Every thing stays a durable External Entity. We do not go back to storing
events only. But kinds have different lifetimes, and the page should show
that. Kinds also have lifecycle stages, and for some kinds seeing the stage
matters more than for others.

## Two properties per kind

**Lifetime** is how long a thing of this kind usually stays relevant: its
typical span. It decides whether the thing belongs to the page's spine
(lasting) or to its stream (standing and passing). It never decides whether
the thing is stored.

| Lifetime | Typical span | Kinds |
|---|---|---|
| lasting | weeks to months | Linear issue, GitHub issue, Sentry issue |
| standing | days | pull request, email thread, Intercom conversation |
| passing | hours | Slack or Discord thread, PagerDuty incident, calendar invite, Vercel deployment |

**What lateness does** (`onOverdue`) is a second, separate declaration. It
says what happens when patience runs out while it is your turn:

- **presses**: it gets louder and stays (email, review request, Intercom,
  Sentry error, PagerDuty incident);
- **lapses**: it leaves the stream and is counted as missed, still stored
  (Slack or Discord mention, calendar invite once the event starts);
- **none**: it has no clock (Linear issue, GitHub issue, deployment).

The two do not line up, and the PagerDuty incident is the case that shows it:
it is passing, since it lives for hours, but it presses until someone acts.
The first draft of this model tied "passing" to "lapses" and "standing" to
"presses"; the Horizon variant's grid showed that half its cells could never
hold anything, and session f38e3c8b named the cause.

A kind's lifetime is a default. The world holds things that break it on
purpose (a pull request open 3 weeks, a 4-month-old Sentry error and one that
lived 2 hours, a Slack thread alive for 6 days, an email thread running 2
months), so no variant looks right only by construction.

**Stage** is where a thing is in its lifecycle. The kind says how much the
stage matters to see:

- **track**: the stages are an ordered path, and where the thing stands on
  that path is the main fact about it. Drawn as a track of stages.
- **state**: one current state is enough, and states can cycle. Drawn as a
  word and a shape, with a trend where the source has one.
- **turn**: there are no stages, only whose turn it is: yours, theirs, or
  nobody's. Drawn as "waiting on you" or "waiting on Priya".

Every thing also has:

- **turn and asksYou.** Two things can both be your turn and read very
  differently: someone waits on you (`asksYou`), or you drive it and nothing
  blocks it.
- **flags**: facts that are not steps on the path, such as "Checks failing" or
  "Changes requested" on a pull request.
- **changes**: its history, `{ atMin, label, stage? }`. An External Entity
  already keeps a short timeline of what changed at its source (spec 20
  section 8.7), so tracks and pulses with time on them are drawn from data the
  model has.

## The table

| Source | Kind | Lifetime | Stage weight | Stages, in order | Patience |
|---|---|---|---|---|---|
| Linear | Issue | lasting | track | Triage, Backlog, Todo, In Progress, In Review, Done (Canceled leaves the path) | none (slow) |
| GitHub | Issue | lasting | state | Open, Closed | none (slow) |
| Sentry | Issue | lasting | state, with a 14-day trend; it cycles | New, Escalating, Ongoing, Resolved, Regressed | 4h while New, Escalating or Regressed |
| GitHub | Pull request | standing | track, plus flags | Draft, In review, Approved, Merged (Closed leaves the path); Checks failing and Changes requested are flags | 1d for a review asked of you |
| Gmail | Thread | standing | turn | waiting on you, waiting on them, FYI | 1d when it is your turn |
| Intercom | Conversation | standing | turn | waiting on you, waiting on customer, closed | 2h when it is your turn |
| Slack | Thread | passing | turn | unanswered, answered | 4h |
| Discord | Thread | passing | turn | unanswered, answered | 1d |
| PagerDuty | Incident | passing | track, short | Triggered, Acknowledged, Resolved | 30m |
| Calendar | Invite | passing | turn, with a deadline | needs an answer, answered | until the event starts |
| Vercel | Deployment | passing | state | Building, Error, Ready | none |

## What lifetime should change on the page (a hypothesis)

- **Lasting** things are the spine. They take rows that stay put, are grouped
  by subject (the links between things), and show their stage.
- **Things fade by turn, never by age.** An email that has waited on you for 3
  days presses harder; it does not go pale. A thing fades when the turn leaves
  you or it settles. Age only says how much patience is used.
- **A passing thing linked to a lasting one** rides on it, as spec 20 section
  8.6 already decides for a compact thing with a confirmed link. When it asks
  something of you, its ask is the lead's sentence, so it can be answered
  from the lead. Its pulse on the lead's timeline is only its history.
- **A passing thing with no link** lives in a stream, and lapses from it as
  described above.
- **A subject with no lasting thing**, such as hiring a candidate (an email
  thread, an invite and a Slack message), still has to have a place. Each
  variant answers where.

## How this relates to spec 20

The spec already declares per kind `card` (rich or compact), `pace` (fast,
slow or context), `patience`, `norm` and `status_key`. Roughly:

- rich and slow is close to lasting;
- compact and fast is close to standing or passing.

But nothing in the spec yet tells standing from passing, and nothing says how
much a kind's stage matters. Part of what this prototype answers is whether a
kind needs those two declarations. If it does, they are plugin declarations
next to `card` and `pace`, not code that branches on `kind` in the client.

## Round three (2026-11-10, session 501370b2 alone)

Rogier kept Spine and Horizon as two views on the same data, and asked for:

- **Cards that look like their source.** `cards.tsx` draws each kind as its source would. This contradicts spec 17 §Inbox › Cards ("the generic card has no branch on kind"). In real code each plugin would contribute its card face; the prototype switches on the kind to learn whether the faces are worth that change.
- **No deadline the source did not give.** "1h left" was the kind's patience minus the wait: a Hercule declaration, not a fact from Slack. Now a card says how long it has waited ("waiting 3h", bold once past patience), and "left" or "due" appears only for real times: an invite's event, a due date, Intercom's own "reply due".
- **Room.** Fewer things per group, larger spacing.
- **A page the user arranges** (`view-layout.tsx`): blocks, each a question over the data plus a way to draw the answer.
- **The bigger picture.** `world.ts` now has Linear initiatives and projects with other people's issues (`world.others`, `concernsYou: false`). These are never on the Inbox; the Spine's Big picture reads them through the projects.
