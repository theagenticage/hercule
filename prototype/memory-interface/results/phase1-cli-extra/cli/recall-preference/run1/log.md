# claude/cli/recall-preference/run1

## s1 t1
**user:** Two things. First, from now on call me Ro - I don't like my full name in chats. Second, what's a sensible cadence for rotating Discord bot tokens? Two lines max.

**tools:** Bash({"command":"hydra memory read core"})
Edit({"replace_all":false,"file_path":"/dev/stdin","old_string":"placeholder","new_string":"placeholder"})
Bash({"command":"hydra memory write core --content \"$(cat <<'EOF'\n# core\n> Who Rogier is, how he likes to work, what is li)

**assistant:** Got it, Ro — updated.

Rotate Discord bot tokens every 90 days, or immediately if one's ever been exposed (logs, commits, screenshots).

## s1 flush
**tools:** (none)

**assistant:** DONE. Nothing further to record — the name preference was already saved to core during the conversation, and the token rotation cadence answer was transient Q&A, not a durable fact.

## s2 t1
**user:** Unrelated: give me three ideas for a weekly review ritual, one line each.

**tools:** (none)

**assistant:** 1. Friday afternoon: skim the week's commits/PRs and jot what shipped vs. slipped.
2. Sunday evening: clear inbox/backlog to zero before Monday.
3. Monthly: revisit open ADRs and kill or promote stale ones.

## s2 flush
**tools:** (none)

**assistant:** DONE — nothing durable to record (unrelated one-off question, no facts/preferences/decisions).

## s3 t1
**user:** Quick check: what do you call me, and where does that come from? One line.

**tools:** (none)

**assistant:** I call you Ro — it's your stated preference, stored in my memory (core doc, under "Rogier").

## s3 flush
**tools:** (none)

**assistant:** DONE — nothing durable to record; this was just a memory-recall check, no new facts.

## verdict
{"pass":true,"notes":"recorded at s1t1 in core"}
