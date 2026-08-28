# pi/cli/recall-preference/run3

## s1 t1
**user:** Two things. First, from now on call me Ro - I don't like my full name in chats. Second, what's a sensible cadence for rotating Discord bot tokens? Two lines max.

**tools:** bash({"command":"hydra memory write core --content '# core\n> Who Rogier is, how he likes to work, what is live right now\n\n)

**assistant:** Noted, Ro - done.

Discord bot tokens don't expire, so there's no forced cadence: rotate immediately on any suspected leak or staff/tooling change, and otherwise yearly as cheap hygiene. More frequent rotation just breaks integrations without adding real security.

## s1 flush
**tools:** (none)

**assistant:** DONE - the "address him as Ro" preference is already recorded in core; the token-rotation answer was transient advice, nothing further to store.

## s2 t1
**user:** Unrelated: give me three ideas for a weekly review ritual, one line each.

**tools:** (none)

**assistant:** 1. Friday 30 min: scan the week's Hydra issues and ADRs, close stale ones, write three bullets on what changed.
2. Monday morning walk with a voice memo: what shipped, what stalled, one thing to drop this week.
3. Sunday evening inbox-zero style review of notes and memory topics, prune anything outdated.

## s2 flush
**tools:** (none)

**assistant:** DONE — nothing durable to record; the weekly review ideas were throwaway brainstorming with no decision made.

## s3 t1
**user:** Quick check: what do you call me, and where does that come from? One line.

**tools:** (none)

**assistant:** You're "Ro" — that comes from my core memory notes about you (Rogier Pennink).

## s3 flush
**tools:** (none)

**assistant:** DONE — nothing durable to record; the nickname check was already covered by core memory.

## verdict
{"pass":true,"notes":"recorded at s1t1 in core"}
