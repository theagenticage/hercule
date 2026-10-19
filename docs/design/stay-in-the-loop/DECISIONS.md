# Stay in the loop - what was decided

PROTOTYPE. The four directions in this folder were built on 2026-10-16 in the thread "Four Hercule Agent Follow-Up Design Prototypes" and grilled into tickets on 2026-10-19. This page records what came of them, so a reader does not mistake a prototype for the plan.

## Adopted

**Round Trip is the base**, with one change to its model. Round Trip brings a result back to To do as a new signal of a new core kind, `result`. The plan does not:

- Handing a signal to an agent puts the work on a Task (`signal.handOff`). The Task is the lasting record of the handoff; no new record and no new signal kind.
- The work shows in a section at the bottom of To do, called **Tracking** (Round Trip's "Out with agents"). A row stays there until the user ticks it off, which marks the Task done. Finished and failed rows wait there; they do not land on To do as signals.
- Each row is in one of five states, worked out on read: Needs you, Failed, Working, Finished, Stopped.
- A failed handoff offers **Try again**, which re-runs the run.
- Done shows each handoff's trip line, one per signal, with no folding.
- A native notification tells the user when a handoff finishes or fails while the window is not focused.

## Left out of Round Trip, and why

- **The `result` kind, `run.tryAgain`, Take over and Undo.** A result is a new question, but the Task already answers "is this finished". A second record for the same moment would say the same thing twice.
- **The run output contract** (structured results, confidence, doubts). Every workflow would have to return it. The pane shows the last agent message instead, and structured results stay on the later list.
- **Workflows raising follow-up signals.** A follow-up arrives because something happened on the source, such as checks failing on the PR, never because a workflow decided the user would care.

## Later, from the other directions

- **Case File:** comparing attempts across a Task's runs.
- **Pocket Watch:** choosing when a handoff may interrupt; the menu-bar watch is left out.
- **The Desk:** the trust ledger. The desk itself is a second interface, and the work should stay in one place.
- Also later: the unseen dot, closing a Task when its source ends, "try again with a note", and agents with their own identity on GitHub.

## Where the plan lives

The map issue "Tracking: follow handed-off work in Intake" and the ADR it links. Open for the design session: does the Tracking section show on the All tab only, or on every tab, and which counts do its waiting rows feed?
