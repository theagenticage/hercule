# The Inbox: motion

The shared language is in `SHARED.md` on `prototype/overview-hifi`: named durations and eight springs. The Inbox uses those names and adds none. `js/motion.js` builds each spring as a CSS `linear()` curve from its stiffness and damping, so a transition stays on the compositor and retargets when interrupted.

| Spring | k / c | Used here for |
|---|---|---|
| `carry` | 900 / 48 | A carried card following the pointer |
| `glide` | 420 / 36 | Cards taking new places in a stack; a line rolling in |
| `drop` | 520 / 30 | A new card arriving; a head rising |
| `return` | 300 / 30 | A carried card going home |
| `open` | 260 / 28 | A card opening |
| `fan` | 340 / 26 | A tray opening; the rail rising |
| `fold` | 300 / 32 | A pile closing |
| `bump` | 900 / 28 | A card's knock when a signal lands |

Three rules, on top of the shared ones:

1. **The Inbox is still at rest.** Nothing loops. Motion happens only because something happened.
2. **Nothing moves under the pointer by itself.** Only the card you are on responds, and neighbours wait until the pointer leaves.
3. **Every move shows where the thing went.** A Task flies to Overview. A raised signal flies to Cards.

The transitions are specified below as built. See `js/` for the exact code.
