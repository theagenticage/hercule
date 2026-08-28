# pi/hybrid/recall-preference/run1

## s1 t1
**user:** Two things. First, from now on call me Ro - I don't like my full name in chats. Second, what's a sensible cadence for rotating Discord bot tokens? Two lines max.

**tools:** read({"path":"memory/core.md"})
bash({"command":"hydra memory write core --content '# core\n> Who Rogier is, how he likes to work, what is live right now\n\n)

**assistant:** Noted, Ro.

No fixed schedule needed: rotate on suspected leak, offboarding, or roughly yearly as hygiene. Regenerate via the Developer Portal and deploy quickly, since the old token dies instantly and your bot will drop offline until the new one is in place.

## s1 flush
**tools:** (none)

**assistant:** DONE
Nothing new to write: the only durable item ("call me Ro") was already recorded in core when you asked.

## s2 t1
**user:** Unrelated: give me three ideas for a weekly review ritual, one line each.

**tools:** (none)

**assistant:** 1. Friday 16:00, 20 minutes: skim the week's Hydra session logs, write down what shipped, what stalled, and the one thing to fix next week.
2. Monday 08:30, look at open ADRs and issues only: close stale ones, pick the week's single priority before touching code.
3. Sunday evening, 10 minutes brain-dump into memory: record decisions, new facts, and people updates so nothing depends on recall.

## s2 flush
**tools:** (none)

**assistant:** DONE — nothing durable to record (suggestions were given but no decision or preference was expressed).

## s3 t1
**user:** Quick check: what do you call me, and where does that come from? One line.

**tools:** (none)

**assistant:** I call you Ro — it's in my core memory notes about you (Rogier Pennink, and you dislike your full name in conversation).

## s3 flush
**tools:** (none)

**assistant:** DONE — nothing to record; the only exchange (the "Ro" nickname question) was already covered by existing core memory.

## verdict
{"pass":true,"notes":"recorded at s1t1 in core"}
