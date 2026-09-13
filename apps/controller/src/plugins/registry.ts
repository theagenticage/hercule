/**
 * The one static registry: installed means listed here and compiled in.
 *
 * There is no discovery and no install step, so this file is the whole
 * inventory, and its order is the order Settings > Plugins lists them in.
 */
import type { Plugin } from "@hydra/plugin-host";
import { claudeCode } from "@hydra/plugin-claude-code";
import { codex } from "@hydra/plugin-codex";
import { github } from "@hydra/plugin-github";
import { pi } from "@hydra/plugin-pi";

export const registry: ReadonlyArray<Plugin> = [claudeCode, codex, pi, github];
