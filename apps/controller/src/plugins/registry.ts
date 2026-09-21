/**
 * The one static registry: installed means listed here and compiled in.
 *
 * There is no discovery and no install step, so this file is the whole
 * inventory, and its order is the order Settings > Plugins lists them in.
 */
import type { Plugin } from "@hercule/plugin-host";
import { claudeCode } from "@hercule/plugin-claude-code";
import { codex } from "@hercule/plugin-codex";
import { github } from "@hercule/plugin-github";
import { pi } from "@hercule/plugin-pi";

export const registry: ReadonlyArray<Plugin> = [claudeCode, codex, pi, github];
