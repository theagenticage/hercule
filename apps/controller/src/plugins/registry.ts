/**
 * The static plugin registry. A plugin is installed when it is listed here and
 * compiled in.
 *
 * There is no discovery and no install step, so this file lists every plugin,
 * in the order Settings > Plugins shows them.
 */
import type { Plugin } from "@hercule/plugin-host";
import { claudeCode } from "@hercule/plugin-claude-code";
import { codex } from "@hercule/plugin-codex";
import { github } from "@hercule/plugin-github";
import { pi } from "@hercule/plugin-pi";

export const registry: ReadonlyArray<Plugin> = [claudeCode, codex, pi, github];
