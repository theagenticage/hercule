// PROTOTYPE - the list of design systems and screens, read by index.html and compare.html.
window.DESIGNS = [
  { id: "01-docket", name: "Docket", thesis: "The unit of the interface is a decision." },
  { id: "02-metro", name: "Metro", thesis: "Every piece of work travels a line." },
  { id: "03-aurora", name: "Aurora", thesis: "Calm glass, living light." },
  { id: "04-tide", name: "Tide", thesis: "Time is the interface." },
  { id: "05-postmark", name: "Postmark", thesis: "Everything that arrives gets stamped." },
  { id: "06-halo", name: "Halo", thesis: "Glance, don't read." },
  { id: "07-crew", name: "Crew", thesis: "Your agents are colleagues." },
  { id: "08-console", name: "Console", thesis: "Keyboard at the speed of thought." },
  { id: "09-spectrum", name: "Spectrum", thesis: "Color is context." },
  { id: "10-concierge", name: "Concierge", thesis: "Talk to one, command many." },
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
