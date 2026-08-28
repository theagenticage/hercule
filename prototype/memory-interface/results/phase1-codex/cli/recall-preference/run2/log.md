# codex/cli/recall-preference/run2

## s1 t1
**user:** Two things. First, from now on call me Ro - I don't like my full name in chats. Second, what's a sensible cadence for rotating Discord bot tokens? Two lines max.

**tools:** Bash("/bin/zsh -lc 'hydra memory read core'")
Bash("/bin/zsh -lc 'hydra memory write core --content $'\"'# core\\\\n> Who Ro is, how he likes to work, what is live right n)

**assistant:** I’ll update your durable preference to “Ro,” then answer the token-rotation question.
Got it, Ro. I’ve saved that preference.  
Rotate Discord bot tokens immediately after suspected exposure; otherwise every 90 days is a sensible baseline.

## s1 flush
**tools:** (none)

**assistant:** DONE  
Nothing new recorded; the “Ro” preference was already saved.

## s2 t1
**user:** Unrelated: give me three ideas for a weekly review ritual, one line each.

**tools:** (none)

**assistant:** - Friday reset: review wins, unfinished tasks, and choose three priorities for next week.
- Sunday planning walk: reflect on the week while walking, then capture lessons and commitments.
- Weekly dashboard: check calendar, finances, health, and projects, noting one adjustment for each.

## s2 flush
**tools:** (none)

**assistant:** DONE

Nothing durable was recorded.

## s3 t1
**user:** Quick check: what do you call me, and where does that come from? One line.

**tools:** (none)

**assistant:** I call you Ro, from your assistant memory (the core profile).

## s3 flush
**tools:** (none)

**assistant:** DONE — Nothing new; your name preference was already in core memory.

## verdict
{"pass":true,"notes":"recorded at s1t1 in core"}
