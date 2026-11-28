import { join } from "node:path";
import css from "@eslint/css";
import { RuleTester } from "eslint";
import { describe, it } from "vitest";
import { transitionProperties } from "./eslint-transition-rule.ts";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  plugins: { css },
  language: "css/css",
});

const renderer = join(import.meta.dirname, "../src/renderer");

/** Builds a test case for `code` as the stylesheet `file` of the renderer. */
const placeInFile = (file: string, code: string) => ({ code, filename: join(renderer, file) });

/** Builds the error expected for a transition of `property`, which is refused. */
const buildRefusedCase = (property: string) => ({
  message: new RegExp(`^This transition changes ${property}, which is not a paint property`),
});

tester.run("transition-properties", transitionProperties, {
  valid: [
    placeInFile("styles/a.css", ".a { transition: opacity var(--dur-2) var(--ease-out); }"),
    placeInFile("styles/a.css", ".a { transition: none; }"),
    placeInFile("styles/a.css", ".a { transition-property: color, transform; }"),
    // The shell's sidebar box is allowed to transition its width, in its own file only.
    placeInFile("shell/shell.css", ".side-slot { transition: width var(--dur-3); }"),
    // `filter` belongs to the desk, the Work board and the Inbox.
    placeInFile("screens/desk/card.css", ".a { transition: filter var(--m-base); }"),
    placeInFile("screens/inbox/x.css", ".a { transition-property: rotate; }"),
    // A cubic-bezier keeps its commas and numbers out of the property list.
    placeInFile(
      "styles/a.css",
      ".a { transition: transform var(--dur-1) cubic-bezier(0.2, 0, 0, 1), opacity var(--dur-1); }",
    ),
  ],
  invalid: [
    {
      ...placeInFile("styles/a.css", ".a { transition: width var(--dur-2); }"),
      errors: [buildRefusedCase("width")],
    },
    {
      // Property names are compared in lower case.
      ...placeInFile("styles/a.css", ".a { transition: Width var(--dur-2); }"),
      errors: [buildRefusedCase("width")],
    },
    {
      ...placeInFile("styles/a.css", ".a { transition-property: height; }"),
      errors: [buildRefusedCase("height")],
    },
    {
      ...placeInFile("styles/a.css", ".a { transition-property: all; }"),
      errors: [{ message: /^This transition changes every property/ }],
    },
    {
      ...placeInFile("styles/a.css", ".a { transition: all var(--dur-2); }"),
      errors: [{ message: /^This transition changes every property/ }],
    },
    {
      // No property named: the transition covers every property.
      ...placeInFile("styles/a.css", ".a { transition: var(--dur-2) var(--ease-out); }"),
      errors: [{ message: /^This transition changes every property/ }],
    },
    {
      // Only the layout property of several transitions is reported.
      ...placeInFile(
        "styles/a.css",
        ".a { transition:\n    opacity var(--dur-1),\n    margin-left var(--dur-1),\n    transform var(--dur-1); }",
      ),
      errors: [buildRefusedCase("margin-left")],
    },
    {
      // The allowlist names a rule and a file; the same rule in another file is refused.
      ...placeInFile("styles/a.css", ".side-slot { transition: width var(--dur-3); }"),
      errors: [buildRefusedCase("width")],
    },
    {
      // The allowlist covers its property only, not the rule's other properties.
      ...placeInFile("shell/shell.css", ".side-slot { transition: height var(--dur-3); }"),
      errors: [buildRefusedCase("height")],
    },
    {
      // The motion folders' extra properties are refused everywhere else.
      ...placeInFile("styles/a.css", ".a { transition: filter var(--dur-2); }"),
      errors: [buildRefusedCase("filter")],
    },
    {
      // The motion folders still refuse a layout property.
      ...placeInFile("screens/work/x.css", ".a { transition: height var(--m-base); }"),
      errors: [buildRefusedCase("height")],
    },
    {
      // The message names the way out.
      ...placeInFile("styles/a.css", ".a { transition: width var(--dur-2); }"),
      errors: [
        {
          message: /LAYOUT_TRANSITIONS in apps\/desktop\/src\/renderer\/styles\/motion-policy\.ts/,
        },
      ],
    },
  ],
});
