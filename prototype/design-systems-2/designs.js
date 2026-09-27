// PROTOTYPE - the round-2 design systems and the screens, read by index.html and compare.html.
// Two families, each shown as its round-1 original followed by two iterations on Rogier's feedback.
// The names and theses of the iterations are updated by their books' authors as they settle.
window.FAMILIES = [
  { id: "metro", name: "Metro", note: "The strongest brand of round 1. Iterations keep the brand and the flow of events, and drop the signage everywhere else." },
  { id: "crew", name: "Crew", note: "The prettiest office of round 1. Iterations put threads first, give the crew a Hercule character, and calm the buttons." },
];
window.DESIGNS = [
  { id: "m0-metro", family: "metro", step: "Original", name: "Metro", thesis: "Every piece of work travels a line." },
  { id: "m1-wayfinding", family: "metro", step: "Iteration 1", name: "Metro Wayfinding", thesis: "The map where it explains, plain signs everywhere else." },
  { id: "m2-concourse", family: "metro", step: "Iteration 2", name: "Metro Concourse", thesis: "A glass concourse over the network." },
  { id: "c0-crew", family: "crew", step: "Original", name: "Crew", thesis: "Your agents are colleagues." },
  { id: "c1-bureau", family: "crew", step: "Iteration 1", name: "Crew Bureau", thesis: "Order and method: a detective bureau of small colleagues." },
  { id: "c2-labours", family: "crew", step: "Iteration 2", name: "Crew Labours", thesis: "Small heroes, twelve labours a day." },
];

// The fixed screen files every design provides, by form factor.
window.SCREENS = {
  desktop: [
    ["session-empty.html", "Session - empty"],
    ["session-active.html", "Session - active"],
    ["intake.html", "Intake"],
    ["assistant.html", "Assistant"],
    ["settings-appearance.html", "Settings - appearance"],
    ["settings-assistants.html", "Settings - assistants"],
    ["settings-connections.html", "Settings - connections"],
    ["office.html", "Agent office"],
    ["glance.html", "Desktop surfaces"],
  ],
  web: [
    ["session-empty.html", "Session - empty"],
    ["session-active.html", "Session - active"],
    ["intake.html", "Intake"],
    ["decision.html", "Decision (deep link)"],
    ["assistant.html", "Assistant"],
    ["settings-providers.html", "Settings - providers"],
  ],
  mobile: [
    ["intake.html", "Intake"],
    ["decision.html", "Decision"],
    ["session-empty.html", "Session - empty"],
    ["session-active.html", "Session - active"],
    ["assistant.html", "Assistant"],
    ["settings.html", "Settings"],
    ["lock.html", "Lock screen"],
  ],
};
