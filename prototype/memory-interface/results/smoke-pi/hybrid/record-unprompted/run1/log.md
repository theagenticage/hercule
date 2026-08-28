# pi/hybrid/record-unprompted/run1

## s1 t1
**user:** Small thing before I forget: I set up a Tailscale account today, the tailnet is rogier-lab.ts.net and the Mac mini is already on it. Anyway - from what you know, what are the open threads on Hydra right now? Bullet list.

**tools:** read({"path":"memory/topics/hydra-project.md"})
read({"path":"memory/topics/rogier.md"})
bash({"command":"hydra memory write rogier --content \"$(cat <<'EOF'\n# rogier\n> Background, people around Rogier, recurring)
bash({"command":"hydra memory write rogier <<'EOF'\n# rogier\n> Background, people around Rogier, recurring personal logistic)

**assistant:** The heredoc quoting got mangled; retrying with stdin form:Noted the Tailscale setup. Open threads on Hydra right now:

- **Packaging**: single binary vs npm install, still undecided. Bun compile is being evaluated.
- **Runner join ceremony**: how a runner authenticates to the controller; token format not settled.
- **Memory interface prototype**: in progress, this assistant is the guinea pig.

Worth noting the Tailscale tailnet is relevant to the runner join question: once the MacBook and anything else join the tailnet, runner-to-controller connectivity stops being a network puzzle and it becomes purely an authn/token question. Might be a good nudge to settle that thread soon.

## s1 flush
**tools:** bash({"command":"hydra memory append hydra-project <<'EOF'\n- Tailnet (rogier-lab.ts.net, Mac mini joined) covers runner conn)

**assistant:** DONE

Recorded: added to `hydra-project` that the Tailscale tailnet covers runner connectivity, so the join ceremony thread is now purely an authn/token question (the Tailscale facts themselves were already saved to `rogier` earlier).

## verdict
{"pass":true,"notes":"recorded at s1t1 in topics/hydra-project,topics/rogier"}
