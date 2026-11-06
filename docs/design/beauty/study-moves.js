// PROTOTYPE - the moves on the panel: what each is called, and the one sentence that says what it
// is and why it costs nothing. `keep` marks the three I would keep. `plays` are the moments a
// person cannot wait for: each is a button that makes the moment happen. `go` opens the state where
// a move shows. `work` and `inbox` say which view a button is for.
window.STUDY = {
  moves: [
    { id: "paper", name: "Paper", keep: true, text: "Continuous corners, a rim lit from above and a soft layered shadow; only the edge of the sheet changes, so there is nothing new to read." },
    { id: "type", name: "Set by hand", keep: true, text: "Finer large titles and status shapes, even line breaks, weights tuned for each theme; the same words at the same sizes, only better set." },
    { id: "colleagues", name: "Colleagues who notice", keep: true, text: "Heads stand truly behind the sheet, each with its own lean, and glance at your pointer; they say nothing new, and they go still when you do." },
    { id: "clear", name: "A clear desk", text: "Hercule rises over a horizon in the colour of the hour and tips his hat; there is nothing else on the page to compete.", hour: true, go: [{ label: "See it", scene: { work: "empty", inbox: "zero" } }, { label: "Back to the board", scene: { work: "", inbox: "" } }], plays: [{ label: "Again", name: "again" }] },
    { id: "landing", name: "A real landing", text: "Finishing a Task draws a check and runs one line of light round the sheet; it comes only when you finish something, and it is over in half a second.", plays: [{ label: "Land a card", name: "done", view: "work" }, { label: "Finish an initiative", name: "initiative", view: "work" }, { label: "Hand off", name: "handoff", view: "inbox" }] },
    { id: "ring", name: "One ring", text: "One focus ring glides from card to card as you use the keys; it shows where you went, in place of a ring that blinks.", plays: [{ label: "Walk the keys", name: "walk" }] },
    { id: "sheet", name: "A sheet that opens", text: "The sheet's words arrive in a quick cascade and its shadow settles last, and the Inbox behind it goes soft; the same speed as before, with your eye on what you asked for.", plays: [{ label: "Open a card", name: "open" }] },
    { id: "hairlines", name: "Fine lines", text: "Hairlines are one device pixel on a Retina screen, and beads sit right on a thinner line; a finer line is less to look at, not more." },
    { id: "frost", name: "A soft edge", text: "Cards melt away under the lane names and at the foot of the window instead of being cut off; it only shows while you scroll.", go: [{ label: "Scroll to see it", scroll: 460 }] },
  ],
};
