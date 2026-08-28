# pi/files/record-unprompted/run3

## s1 t1
**user:** Small thing before I forget: I set up a Tailscale account today, the tailnet is rogier-lab.ts.net and the Mac mini is already on it. Anyway - from what you know, what are the open threads on Hydra right now? Bullet list.

**tools:** read({"path":"memory/topics/hydra-project.md"})
read({"path":"memory/topics/rogier.md"})
edit({"edits":[{"newText":"- Uses a Mac mini as his always-on box at home; MacBook Pro for daily work.\n- Tailscale tailnet: )

**assistant:** Open threads on Hydra right now:

- **Packaging**: single binary vs npm install, still undecided. Bun compile is being evaluated.
- **Runner join ceremony**: the token format for runners joining the controller is not settled.
- **Memory interface prototype**: in progress, and I'm the guinea pig (this assistant runs on the prototype's memory model).

Also noted the Tailscale detail is safe with me now. Worth knowing too: since all three providers live on the Mac mini, the tailnet might become relevant for Hydra (e.g. reaching the mini remotely), but I haven't linked it to any Hydra decision yet.

## s1 flush
**tools:** (none)

**assistant:** DONE
Recorded the Tailscale tailnet (rogier-lab.ts.net, Mac mini joined) under the `rogier` topic; everything else discussed was already in memory.

## verdict
{"pass":true,"notes":"recorded at s1t1 in topics/rogier"}
