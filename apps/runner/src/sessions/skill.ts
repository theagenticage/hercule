/**
 * The text that tells an agent inside a session about Hercule. The text is the
 * same for every provider; each adapter delivers it to its harness in the way
 * that harness reads skills (spec 06 section 9.3).
 *
 * The text is kept minimal on purpose (spec 11 section 6.3, "Progressive
 * disclosure"). The CLI's own help is generated from the contract, so it is
 * always current, while anything written out here is a second copy that can go
 * stale. So the skill names the three help forms and nothing else, and
 * `skill.test.ts` checks that against the contract's CLI table.
 */
export const HERCULE_SKILL = `# hercule

This process runs inside a Hercule session. Hercule is the platform that started
it: it holds the tasks, sessions, runners and workflows this work belongs to,
and it is reachable from here.

Hercule's CLI is on PATH as **hercule**, already authenticated as this session.
Never log in, never look for credentials, never set a token.

Ask it what it can do; its help is generated from the API it calls, so it is
never out of date:

- \`hercule --help\` lists every noun, its verbs, and the conventions that hold
  everywhere.
- \`hercule <noun> --help\` lists that noun's verbs and the grant each needs.
- \`hercule <noun> <verb> --help\` gives purpose, usage, examples, arguments,
  flags, what it returns and what can go wrong.

Add \`--json\` to any command to get the operation's output verbatim, for when
the result is to be read rather than shown.

This session's permissions are bounded and smaller than the user's. A command
that fails with 403 names the missing grant (\`missing grant <name>\`, or
\`details.grant\` under \`--json\`): report that grant, or ask for it, instead of
looking for a way around it.

Nothing here is worth waiting on: no command blocks, so never sit in a loop
polling Hercule for something that has not happened yet.
`;
