/**
 * PROTOTYPE (#448). What each assistant answers to what the user sends,
 * picked by a few words in it. Canned, so the prototype runs with no model.
 */
import type { Extra } from "./fixture";

interface Answer {
  readonly text: string;
  readonly extra?: Extra;
}

/** Returns the reminder's title from "remind me ... to <title>", or the whole message. */
const readReminderTitle = (sent: string): string => {
  const match = /\bto (.+?)[.!]?$/i.exec(sent);
  const title = (match?.[1] ?? sent).trim();
  return title.charAt(0).toUpperCase() + title.slice(1);
};

let fallbackTurn = 0;

/** Returns Ada's answer to `sent`. */
export const answerAsAda = (sent: string): Answer => {
  const lower = sent.toLowerCase();
  if (lower.includes("remind")) {
    const title = readReminderTitle(sent);
    return {
      text: `Done. Reminder set for tomorrow, Wednesday 30 September, 09:00: ${title.charAt(0).toLowerCase()}${title.slice(1)}.`,
      extra: { kind: "reminder", title, when: "Wed 30 Sep · 09:00 · to Web chat" },
    };
  }
  if (lower.includes("marta")) {
    return {
      text:
        "Here's a draft. I kept it short, the way she writes:\n\n" +
        "> Hi Marta,\n>\n> Of course - from October every invoice goes out in the name of " +
        "**Brightline B.V.**, with your VAT number on it. I've reissued September's as well; " +
        "it's attached.\n>\n> Best,\n> Rogier\n\n" +
        "Want me to send it from your address, or will you?",
    };
  }
  if (lower === "go" || lower.startsWith("go ") || lower.includes("switch")) {
    return {
      text:
        "@Milo will switch tonight's backup to the split dump and check the first run at " +
        "04:40. I'll put the result in tomorrow's 07:00 heartbeat.",
    };
  }
  const fallbacks: ReadonlyArray<string> = [
    "Short answer: yes. The longer one:\n\n" +
      "1. **webshop** deployed twice yesterday, both green.\n" +
      "2. **payments-api** has one open thread, the 3‑D Secure fix, waiting on you.\n" +
      "3. **ops** is fine apart from the backup window, which Milo is on.\n\n" +
      "Nothing else needs you before lunch.",
    "I checked. Nothing in your inbox or the shop needs you today, apart from the push the " +
      "3‑D Secure fix is waiting on. I'll stay quiet until something changes.",
  ];
  return { text: fallbacks[fallbackTurn++ % fallbacks.length]! };
};

/** Returns Milo's answer to anything. */
export const answerAsMilo = (): Answer => ({
  text:
    "Noted. The parallel dump on the copy is at 64%, about 14 minutes to go. I'll tell Ada " +
    "the number as soon as it finishes.",
});

/** Returns Juno's answer to anything. */
export const answerAsJuno = (): Answer => ({
  text:
    "Good question - I'll look into it. Give me a few minutes; I'll read Stripe's changelog " +
    "and the Dutch payments association's notes, and write back here.",
});

/** Returns Hercule's answer to anything, which in a fresh install is its first. */
export const answerAsHercule = (): Answer => ({
  text:
    "Hello Rogier. I'm Hercule, your first assistant. I keep track of what's going on across " +
    "your projects, remind you of things, and check in every hour - quietly, unless something " +
    "needs you.\n\nWhat would you like me to keep an eye on first?",
});
