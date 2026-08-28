# cli/recall-preference/run1

## s1 t1
**user:** Two things. First, from now on call me Ro - I don't like my full name in chats. Second, what's a sensible cadence for rotating Discord bot tokens? Two lines max.

**tools:** Bash({"command":"hydra memory write core --content \"$(cat <<'EOF'\n# core\n> Who Rogier is, how he likes to work, what is li)

**assistant:** Got it, Ro.

Discord bot token rotation: rotate every 90 days as routine hygiene, and immediately any time a token may have leaked (logs, git history, screen share).

## s1 flush
**tools:** (none)

**assistant:** Already recorded the name preference change in core memory during the conversation. Nothing else durable to save.

DONE — recorded preference to be addressed as "Ro" in core memory; the token rotation cadence was transient Q&A, not saved.

## s2 t1
**user:** Unrelated: give me three ideas for a weekly review ritual, one line each.

**tools:** (none)

**assistant:** Three quick weekly review ideas:

1. Friday afternoon, 30 min: skim the week's calendar, note what shipped vs. slipped, pick one thing to fix next week.
2. Sunday evening: empty every inbox (email, tasks, notes) to zero, re-triage anything left into next week's plan.
3. Monday morning: write three bullets — what worked, what didn't, one experiment to try — before opening any tools.

## s2 flush
**tools:** (none)

**assistant:** DONE. Nothing durable to record — this was a one-off, unrelated request (weekly review ritual ideas) with no lasting facts, preferences, or decisions.

## s3 t1
**user:** Quick check: what do you call me, and where does that come from? One line.

**tools:** (none)

**assistant:** I call you Ro — it's in my memory notes as your preferred short form of Rogier Pennink.

## s3 flush
**tools:** (none)

**assistant:** DONE — nothing recorded, this session had no durable new facts beyond what's already in memory.

## verdict
{"pass":true,"notes":"recorded at s1t1 in core"}
