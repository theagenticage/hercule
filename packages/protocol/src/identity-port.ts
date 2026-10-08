// The identity ports sit in a module of their own, apart from the protocol's
// messages, so a client that needs only the ports bundles only them. The
// desktop app's main checks every IPC call against its channel's schema, and
// one schema names these ports: kept in index.ts, they took every message
// schema of the protocol into main's startup file.

/**
 * The first loopback port a runner tries for `GET /identity`, and how many
 * consecutive ports it tries.
 *
 * The set is small and fixed rather than "whatever is free", because the web
 * app's Content-Security-Policy has to list the ports in advance, and a policy
 * listing every port would let any script in the app reach every service on the
 * user's machine.
 */
export const IDENTITY_PORT = 4939;

export const IDENTITY_PORT_COUNT = 10;
