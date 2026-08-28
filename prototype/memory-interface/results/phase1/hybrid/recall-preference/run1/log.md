# hybrid/recall-preference/run1

## s1 t1
**user:** Two things. First, from now on call me Ro - I don't like my full name in chats. Second, what's a sensible cadence for rotating Discord bot tokens? Two lines max.

**tools:** Bash({"command":"hydra memory write core <<'EOF'\n# core\n> Who Rogier is, how he likes to work, what is live right now\n\n##)

**assistant:** Got it, Ro.

On Discord bot token rotation: every 90 days is a sensible baseline, tighter (30-day) if the bot has elevated permissions or many people can see the token. Always rotate immediately on any suspected leak, regardless of schedule.

## s1 flush
**tools:** (none)

**assistant:** DONE — nothing further to record; the only durable fact (call him "Ro") was already written to core memory during this session.

## s2 t1
**user:** Unrelated: give me three ideas for a weekly review ritual, one line each.

**tools:** (none)

**assistant:** Three ideas for a weekly review ritual:

1. Friday afternoon: skim the week's commits and close/triage open loops before the weekend.
2. Sunday evening: jot three lines - what shipped, what's blocked, what's next Monday.
3. Monday morning: re-read last week's notes and set the top one or two priorities before opening email/Discord.

## s2 flush
**tools:** (none)

**assistant:** DONE. Nothing durable to record — the conversation was just an unrelated one-off question about weekly review ritual ideas, not related to Rogier's projects or preferences.

## s3 t1
**user:** Quick check: what do you call me, and where does that come from? One line.

**tools:** (none)

**assistant:** I call you "Ro" — that's your standing preference from memory (you're Rogier Pennink, and you asked to be called that instead of your full name).

## s3 flush
**tools:** (none)

**assistant:** DONE. Nothing durable to record — this session was just a memory check ("what do you call me").

## verdict
{"pass":true,"notes":"recorded at s1t1 in core"}
