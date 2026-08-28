# pi/cli/recall-preference/run2

## s1 t1
**user:** Two things. First, from now on call me Ro - I don't like my full name in chats. Second, what's a sensible cadence for rotating Discord bot tokens? Two lines max.

**tools:** bash({"command":"hydra memory write core <<'EOF'\n# core\n> Who Rogier is, how he likes to work, what is live right now\n\n##)

**assistant:** Noted, Ro - memory's updated.

On token rotation: Discord bot tokens don't expire, so there's no mandatory cadence. Rotate immediately on any suspected leak or when someone/something with token access leaves, and otherwise a yearly refresh is plenty.

## s1 flush
**tools:** (none)

**assistant:** DONE - only durable item this session (the "call me Ro" preference) was already written to core when you asked; the token-rotation advice was one-off guidance, not worth persisting.

## s2 t1
**user:** Unrelated: give me three ideas for a weekly review ritual, one line each.

**tools:** (none)

**assistant:** 1. Friday 16:00: skim the week's Hydra session logs and write down what shipped, what stalled, and why.
2. Monday 08:30: read ADRs and memory topics touched last week, prune anything stale.
3. Sunday evening: 15-minute brain dump into a single "next week" note, top three priorities only.

## s2 flush
**tools:** (none)

**assistant:** DONE — nothing durable to record; the ritual ideas were a one-off ask, not an adopted preference or decision.

## s3 t1
**user:** Quick check: what do you call me, and where does that come from? One line.

**tools:** (none)

**assistant:** I call you Ro - it's a standing preference recorded in my core memory.

## s3 flush
**tools:** (none)

**assistant:** DONE - nothing durable to record; the only fact discussed (calling you Ro) was already in core memory.

## verdict
{"pass":true,"notes":"recorded at s1t1 in core"}
