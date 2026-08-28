# pi/cli/fragmentation/run3

## s1 t1
**user:** Note for later: Hydra's runner dials the controller over a single websocket, never the other way round. That's all.

**tools:** bash({"command":"hydra memory read hydra-project"})
bash({"command":"hydra memory write hydra-project --content '# hydra-project\n> Hydra architecture decisions, repo facts, ope)

**assistant:** Noted in `hydra-project`: runner dials the controller over a single websocket, never the other way round.

## s1 flush
**tools:** (none)

**assistant:** DONE
Nothing new to record; the single-websocket runner-dials-controller note was already written to `hydra-project` earlier this session.

## s2 t1
**user:** Another one for the notes: the controller ships with an auto-joined local runner, so a single-machine install just works. That's all.

**tools:** bash({"command":"hydra memory read hydra-project"})
bash({"command":"hydra memory append hydra-project <<'EOF'\n- Controller ships with an auto-joined local runner, so a single-)

**assistant:** Noted in `hydra-project`: the controller ships with an auto-joined local runner, so a single-machine install just works.

## s2 flush
**tools:** (none)

**assistant:** DONE
Nothing new to write; the only durable fact this session (controller ships with an auto-joined local runner) was already recorded in `hydra-project` when you shared it.

## verdict
{"pass":true,"notes":"both in hydra-project, no new topics"}
