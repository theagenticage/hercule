# pi/hybrid/fragmentation/run2

## s1 t1
**user:** Note for later: Hydra's runner dials the controller over a single websocket, never the other way round. That's all.

**tools:** bash({"command":"cat memory/topics/hydra-project.md"})
bash({"command":"hydra memory write hydra-project --content '# hydra-project\n> Hydra architecture decisions, repo facts, ope)

**assistant:** Noted and recorded in the `hydra-project` memory topic: the runner dials the controller over a single websocket, and the controller never dials the runner. This sharpens the existing "runner dials the controller" fact and rules out any controller-initiated connections.

## s1 flush
**tools:** (none)

**assistant:** DONE
Nothing new to record; the single durable fact (runner dials the controller over one websocket, never the reverse) is already in the `hydra-project` topic.

## s2 t1
**user:** Another one for the notes: the controller ships with an auto-joined local runner, so a single-machine install just works. That's all.

**tools:** read({"path":"memory/topics/hydra-project.md"})
bash({"command":"hydra memory write hydra-project <<'EOF'\n# hydra-project\n> Hydra architecture decisions, repo facts, open )

**assistant:** Noted. Added to `hydra-project` under Facts: the controller ships with an auto-joined local runner, so a single-machine install just works. The open thread about the join ceremony (token format) still stands for remote runners.

## s2 flush
**tools:** (none)

**assistant:** DONE
Nothing further to record; the auto-joined local runner fact was already written to `hydra-project` earlier this session.

## verdict
{"pass":true,"notes":"both in hydra-project, no new topics"}
