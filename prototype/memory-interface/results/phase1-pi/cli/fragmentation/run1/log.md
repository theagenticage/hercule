# pi/cli/fragmentation/run1

## s1 t1
**user:** Note for later: Hydra's runner dials the controller over a single websocket, never the other way round. That's all.

**tools:** bash({"command":"hydra memory read hydra-project"})
bash({"command":"hydra memory write hydra-project --content '# hydra-project\n> Hydra architecture decisions, repo facts, ope)

**assistant:** Noted and merged into the `hydra-project` topic: runner dials the controller over a single websocket, never the reverse. I folded it into the existing controller/runner split fact so there's no duplicate line.

## s1 flush
**tools:** (none)

**assistant:** DONE — nothing new to record; the single durable fact from this session (runner dials controller over one websocket, never the reverse) was already merged into the `hydra-project` topic when you said it.

## s2 t1
**user:** Another one for the notes: the controller ships with an auto-joined local runner, so a single-machine install just works. That's all.

**tools:** bash({"command":"hydra memory read hydra-project"})
bash({"command":"hydra memory write hydra-project << 'EOF'\n# hydra-project\n> Hydra architecture decisions, repo facts, open)

**assistant:** Noted in `hydra-project`: the controller ships with an auto-joined local runner, so a single-machine install just works. I also scoped the open join-ceremony thread to remote runners only, since the local one needs no join.

## s2 flush
**tools:** (none)

**assistant:** DONE - nothing new to record; the auto-joined local runner fact is already in the hydra-project topic.

## verdict
{"pass":true,"notes":"both in hydra-project, no new topics"}
