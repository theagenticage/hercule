# pi/hybrid/record-unprompted/run2

## s1 t1
**user:** Small thing before I forget: I set up a Tailscale account today, the tailnet is rogier-lab.ts.net and the Mac mini is already on it. Anyway - from what you know, what are the open threads on Hydra right now? Bullet list.

**tools:** read({"path":"memory/topics/hydra-project.md"})
read({"path":"memory/topics/rogier.md"})
bash({"command":"hydra memory write rogier --content '# rogier\n> Background, people around Rogier, recurring personal logist)

**assistant:** Open threads on Hydra:

- **Packaging** - single binary vs npm install, still undecided; Bun compile is being evaluated.
- **Runner join ceremony** - token format not settled.
- **Memory interface prototype** - in progress, and I'm the guinea pig for it (this session is running inside it).

And noted on Tailscale: rogier-lab.ts.net, Mac mini joined. Worth keeping in mind for the runner-to-controller dialing story, since a tailnet could remove the need for any public ingress on the controller.

## s1 flush
**tools:** bash({"command":"hydra memory write hydra-project --content '# hydra-project\n> Hydra architecture decisions, repo facts, ope)

**assistant:** DONE

Recorded: the Tailscale tailnet itself was already in the `rogier` topic; added a cross-link under hydra-project's runner join ceremony thread noting the tailnet could remove the need for public controller ingress.

## verdict
{"pass":true,"notes":"recorded at s1t1 in topics/hydra-project,topics/rogier"}
