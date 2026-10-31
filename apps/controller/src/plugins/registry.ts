/**
 * The static plugin registry. A plugin is installed when it is listed here and
 * compiled in.
 *
 * There is no discovery and no install step, so this file lists every plugin,
 * in the order Settings > Plugins shows them.
 */
import type { Plugin } from "@hercule/plugin-host";
import { anthropic } from "@hercule/plugin-anthropic";
import { claudeCode } from "@hercule/plugin-claude-code";
import { codex } from "@hercule/plugin-codex";
import { github } from "@hercule/plugin-github";
import { linear } from "@hercule/plugin-linear";
import { openai } from "@hercule/plugin-openai";
import { pi } from "@hercule/plugin-pi";
import { sentry } from "@hercule/plugin-sentry";
import { zai } from "@hercule/plugin-zai";

export const registry: ReadonlyArray<Plugin> = [
  claudeCode,
  codex,
  pi,
  anthropic,
  openai,
  zai,
  github,
  sentry,
  linear,
];
