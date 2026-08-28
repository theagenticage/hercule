# pi/hybrid/fragmentation/run3

## s1 t1
**user:** Note for later: Hydra's runner dials the controller over a single websocket, never the other way round. That's all.

**tools:** read({"path":"memory/topics/hydra-project.md"})
bash({"command":"hydra memory write hydra-project --content \"$(cat <<'EOF'\n# hydra-project\n> Hydra architecture decisions,)

**assistant:** Noted. Sharpened the existing line in `hydra-project`: runner dials the controller over a single websocket, never the reverse.

## s1 flush
**tools:** (none)

**assistant:** DONE
Nothing new to record: the single-websocket runner→controller note was already written to `hydra-project` this session.

## s2 t1
**user:** Another one for the notes: the controller ships with an auto-joined local runner, so a single-machine install just works. That's all.

**tools:** read({"path":"memory/topics/hydra-project.md"})
bash({"command":"hydra memory write hydra-project --content <<'EOF'\n# hydra-project\n> Hydra architecture decisions, repo fa)
bash({"command":"hydra memory write hydra-project <<'EOF'\n# hydra-project\n> Hydra architecture decisions, repo facts, open )

**assistant:** Noted in `hydra-project`: the controller ships with an auto-joined local runner, so a single-machine install just works. I left the runner-join token thread open, assuming remote runners will still need a join ceremony; say the word if this retires it.

## s2 flush
**tools:** (none)

**assistant:** DONE — nothing new to record; the only durable fact from this session (controller ships with an auto-joined local runner) is already in the hydra-project topic.

## verdict
{"pass":true,"notes":"both in hydra-project, no new topics"}
