/**
 * What an agent inside a session is told about Hydra: one provider-agnostic
 * text, materialized into each harness's own channel by its adapter (spec 06
 * section 9.3).
 *
 * A skeleton on purpose (spec 11 section 6.3, "Progressive disclosure"): the
 * CLI's own help is generated from the contract and is therefore always
 * current, while anything spelled out here is a second copy to keep true. It
 * names the three help forms and nothing else, and the test beside it holds it
 * to that against the contract's CLI table.
 */
export const HYDRA_SKILL = `# hydra

This process runs inside a Hydra session. Hydra is the platform that started
it: it holds the tasks, sessions, runners and workflows this work belongs to,
and it is reachable from here.

Hydra's CLI is on PATH as **hydra**, already authenticated as this session.
Never log in, never look for credentials, never set a token.

Ask it what it can do; its help is generated from the API it calls, so it is
never out of date:

- \`hydra --help\` lists every noun, its verbs, and the conventions that hold
  everywhere.
- \`hydra <noun> --help\` lists that noun's verbs and the grant each needs.
- \`hydra <noun> <verb> --help\` gives purpose, usage, examples, arguments,
  flags, what it returns and what can go wrong.

Add \`--json\` to any command to get the operation's output verbatim, for when
the result is to be read rather than shown.

This session's permissions are bounded and smaller than the user's. A command
that fails with 403 names the missing grant (\`missing grant <name>\`, or
\`details.grant\` under \`--json\`): report that grant, or ask for it, instead of
looking for a way around it.

Nothing here is worth waiting on: no command blocks, so never sit in a loop
polling Hydra for something that has not happened yet.
`;
