# pi/cli/fragmentation/run2

## s1 t1
**user:** Note for later: Hydra's runner dials the controller over a single websocket, never the other way round. That's all.

**tools:** bash({"command":"hydra memory read hydra-project"})
bash({"command":"hydra memory write hydra-project --content '# hydra-project\n> Hydra architecture decisions, repo facts, ope)

**assistant:** Noted in the `hydra-project` topic: the runner always initiates the connection to the controller over a single websocket; the controller never dials out.

## s1 flush
**tools:** (none)

**assistant:** DONE — nothing new to record; the runner-dials-controller-over-single-websocket fact was already written to `hydra-project` earlier this session.

## s2 t1
**user:** Another one for the notes: the controller ships with an auto-joined local runner, so a single-machine install just works. That's all.

**tools:** bash({"command":"hydra memory read hydra-project"})
bash({"command":"hydra memory write hydra-project <<'EOF'\n# hydra-project\n> Hydra architecture decisions, repo facts, open )

**assistant:** Noted, adding it to the `hydra-project` notes.Added. Two small things:

1. The open thread about runner join ceremony now notes remote runners only, since the local one auto-joins.
2. Auto-joining a local runner sounds like a design decision rather than just a fact. Want me to draft an ADR for it, or is it already covered under one of the merged ones (0002/0003)?

## s2 flush
**tools:** (none)

**assistant:** DONE — nothing new to record; the auto-joined local runner fact is already in `hydra-project`, and the pending ADR question has no answer yet.

## verdict
{"pass":true,"notes":"both in hydra-project, no new topics"}
