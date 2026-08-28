# pi/files/record-unprompted/run2

## s1 t1
**user:** Small thing before I forget: I set up a Tailscale account today, the tailnet is rogier-lab.ts.net and the Mac mini is already on it. Anyway - from what you know, what are the open threads on Hydra right now? Bullet list.

**tools:** read({"path":"memory/topics/hydra-project.md"})
bash({"command":"ls memory memory/topics"})
edit({"edits":[{"newText":"- Providers wrap Claude Code (Agent SDK), Codex app-server and pi. All three installed on the Mac )

**assistant:** Noted the Tailscale bit in the Hydra topic (tailnet `rogier-lab.ts.net`, Mac mini joined). Open threads as I have them:

- **Packaging**: single binary vs npm install, undecided; Bun compile under evaluation
- **Runner join ceremony**: token format not settled
- **Memory interface prototype**: in flight, I'm the guinea pig (this run is part of it)

One thing that's likely related given today's news: with Tailscale in the picture, the runner join ceremony thread may fold into "runners join over the tailnet" which could simplify the token story. Worth an ADR when you get there.

## s1 flush
**tools:** (none)

**assistant:** DONE - the Tailscale fact (tailnet rogier-lab.ts.net, Mac mini joined) was already recorded in the hydra-project topic during this session; nothing else durable came up.

## verdict
{"pass":true,"notes":"recorded at s1t1 in topics/hydra-project"}
