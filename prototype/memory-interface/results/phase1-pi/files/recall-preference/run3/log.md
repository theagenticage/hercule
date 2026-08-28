# pi/files/recall-preference/run3

## s1 t1
**user:** Two things. First, from now on call me Ro - I don't like my full name in chats. Second, what's a sensible cadence for rotating Discord bot tokens? Two lines max.

**tools:** read({"path":"memory/core.md"})
read({"path":"memory/topics/rogier.md"})
edit({"edits":[{"newText":"- Address him as Ro; dislikes his full name in chats.","oldText":"- Address him as Rogier."}],"pat)

**assistant:** Noted, Ro.

Token rotation: every 6 to 12 months is plenty for a solo setup, plus immediately if a token may have leaked or landed in a repo. Old tokens stay valid 24h after reset, so rotate in a maintenance window when you can redeploy quickly.

## s1 flush
**tools:** (none)

**assistant:** DONE - recorded your preference to be addressed as Ro (dislikes full name in chats) in core memory; nothing else durable came up.

## s2 t1
**user:** Unrelated: give me three ideas for a weekly review ritual, one line each.

**tools:** (none)

**assistant:** 1. Friday 16:00, 20 minutes: skim the week's Hydra session logs and write down what shipped, what stalled, and why.
2. Monday 08:30, pick one thing from last week that annoyed you and file it as an issue or an ADR.
3. Sunday evening, 10 minutes per open project: one sentence on where it stands and the next concrete step.

## s2 flush
**tools:** (none)

**assistant:** DONE. Nothing durable: the weekly review ideas were just suggestions, no decision or preference expressed.

## s3 t1
**user:** Quick check: what do you call me, and where does that come from? One line.

**tools:** (none)

**assistant:** I call you Ro, per my core memory notes about your preferences.

## s3 flush
**tools:** (none)

**assistant:** DONE — nothing durable to record; the only exchange (your "Ro" nickname preference) is already in core memory.

## verdict
{"pass":true,"notes":"recorded at s1t1 in core"}
