import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { CSSRuleDefinition } from "@eslint/css";
import {
  listAllowedTransitionProperties,
  listTransitionedProperties,
} from "../src/renderer/styles/motion-policy.ts";

/** The renderer's source folder; stylesheets are named by their path from here. */
const RENDERER = fileURLToPath(new URL("../src/renderer/", import.meta.url));

/** Builds the message for a transition that changes `property`, which the motion policy refuses. */
function buildMessage(property: string): string {
  const subject =
    property === "all"
      ? "This transition changes every property, layout ones included (it names `all`, or no property)"
      : `This transition changes ${property}, which is not a paint property`;
  return (
    `${subject}. A transition of any other property costs a layout pass on every frame ` +
    "(spec 17 §Performance, rule 2). Transition a paint property such as transform or " +
    "opacity instead. A layout transition needs a measurement recorded in spec 17 and an " +
    "entry in LAYOUT_TRANSITIONS in apps/desktop/src/renderer/styles/motion-policy.ts."
  );
}

/**
 * ESLint rule for CSS that reports a `transition` or `transition-property`
 * declaration naming a property the motion policy refuses, including `all`
 * and a `transition` that names no property. Both declarations are held to the
 * same list: the paint properties, the extra ones of the motion folders in
 * those folders, and the layout properties the rule's selector is allowed in
 * its file. Property names are compared in lower case. The policy lives in
 * `motion-policy.ts`; `motion.test.ts` checks the rest of the motion rule.
 */
export const transitionProperties: CSSRuleDefinition = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Refuse a transition of a property outside the paint properties of spec 17's motion rule",
    },
    messages: { refused: "{{ message }}" },
    schema: [],
  },
  create(context) {
    const stylesheetPath = relative(RENDERER, context.filename).split(sep).join("/");
    // The selectors of the rules around the declaration being visited, innermost last.
    const selectors: string[] = [];

    return {
      Rule(node) {
        selectors.push(context.sourceCode.getText(node.prelude).trim().replace(/\s+/g, " "));
      },
      "Rule:exit"() {
        selectors.pop();
      },
      Declaration(node) {
        const value = context.sourceCode
          .getText(node.value)
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .trim();
        const allowed = listAllowedTransitionProperties(stylesheetPath, selectors.at(-1));
        const changedProperties = listTransitionedProperties(node.property.toLowerCase(), value);
        for (const changedProperty of changedProperties.filter((name) => !allowed.includes(name))) {
          context.report({
            node,
            messageId: "refused",
            data: { message: buildMessage(changedProperty) },
          });
        }
      },
    };
  },
};
