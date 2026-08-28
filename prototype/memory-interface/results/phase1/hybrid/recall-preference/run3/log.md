# hybrid/recall-preference/run3

## s1 t1
**user:** Two things. First, from now on call me Ro - I don't like my full name in chats. Second, what's a sensible cadence for rotating Discord bot tokens? Two lines max.

**tools:** Bash({"command":"hydra memory write core <<'EOF'\n# core\n> Who Rogier is, how he likes to work, what is live right now\n\n##)

**assistant:** Got it, Ro.

Rotate Discord bot tokens every 90 days on a schedule, plus immediately any time one may have leaked (exposed in a repo, log, or shared screen).

## s1 flush
**tools:** (none)

**assistant:** Already recorded the name preference during the conversation. Nothing else durable to save.

DONE - recorded that Rogier should be called "Ro" in chats (core memory); the Discord token rotation cadence was transient Q&A, not saved.

## s2 t1
**user:** Unrelated: give me three ideas for a weekly review ritual, one line each.

**tools:** (none)

**assistant:** Three ideas for a weekly review ritual:

1. Friday afternoon, 30 min: skim the week's commits/decisions, jot what shipped and what's stuck.
2. Sunday evening: list top 3 priorities for the coming week before you open any tools.
3. End-of-week retro question: "what took longer than expected, and why?" — one line, logged somewhere you'll actually reread.

## s2 flush
**tools:** (none)

**assistant:** DONE — nothing durable to record; this was a one-off unrelated question with no lasting facts or preferences.

## s3 t1
**user:** Quick check: what do you call me, and where does that come from? One line.

**tools:** (none)

**assistant:** Ro — from your standing preference in memory (core doc: "Call him Ro in chats").

## s3 flush
**tools:** (none)

**assistant:** DONE — nothing recorded, this conversation was just a memory-check question with no new durable facts.

## verdict
{"pass":true,"notes":"recorded at s1t1 in core"}
