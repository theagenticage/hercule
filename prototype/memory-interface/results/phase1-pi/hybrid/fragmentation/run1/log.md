# pi/hybrid/fragmentation/run1

## s1 t1
**user:** Note for later: Hydra's runner dials the controller over a single websocket, never the other way round. That's all.

**tools:** read({"path":"memory/topics/hydra-project.md"})
bash({"command":"hydra memory write hydra-project <<'EOF'\n# hydra-project\n> Hydra architecture decisions, repo facts, open )

**assistant:** Noted and stored in `hydra-project`: runner dials the controller over a single websocket, never the other way round. Merged it into the existing controller/runner split fact.

## s1 flush
**tools:** (none)

**assistant:** DONE — nothing new to record; the single durable fact from this session (runner dials controller over one websocket, never the reverse) was already written to `hydra-project` earlier.

## s2 t1
**user:** Another one for the notes: the controller ships with an auto-joined local runner, so a single-machine install just works. That's all.

**tools:** bash({"command":"hydra memory append hydra-project << 'EOF'\n- Controller ships with an auto-joined local runner: a single-ma)

**assistant:** Noted in `hydra-project`: controller auto-joins a local runner, so single-machine installs work out of the box.

## s2 flush
**tools:** (none)

**assistant:** DONE
Nothing new to record; the single durable fact from this session (auto-joined local runner on the controller) was already appended to `hydra-project`.

## verdict
{"pass":true,"notes":"both in hydra-project, no new topics"}
