import { describe, expect, it } from "vitest";
import { buildProject } from "../threads/workspaces.testing";
import {
  buildMcpServerSettingsRows,
  buildUrlServerSettingsRows,
  describeNamingProjects,
} from "./settings-list";
import {
  CONNECTIONS,
  LINEAR,
  OFFERING_PLUGINS,
  SENTRY_HOBBY,
  SENTRY_HOBBY_CONNECTION,
  SENTRY_PLUGIN,
  buildConnection,
  buildServer,
} from "./testing";

const WEBSHOP = { ...buildProject("p-shop", "webshop"), mcpServerIds: ["s-hobby", "s-linear"] };
const BLOG = { ...buildProject("p-blog", "blog"), mcpServerIds: ["s-linear"] };

describe("buildMcpServerSettingsRows", () => {
  it("gives one row for each Connection whose type a plugin offers, ordered by type name then label", () => {
    const rows = buildMcpServerSettingsRows({
      servers: [],
      // Listed out of order on purpose.
      connections: [...CONNECTIONS].reverse(),
      plugins: OFFERING_PLUGINS,
      projects: [],
    });

    expect(rows.map((row) => [row.typeName, row.connection.label])).toEqual([
      ["Linear", "acme"],
      ["Sentry", "hobby"],
      ["Sentry", "work"],
    ]);
  });

  it("shows a Connection whose server is not switched on under the name it will get, off, with no page", () => {
    const [linear] = buildMcpServerSettingsRows({
      servers: [],
      connections: CONNECTIONS,
      plugins: OFFERING_PLUGINS,
      projects: [WEBSHOP],
    });

    expect(linear).toMatchObject({
      view: null,
      name: "linear",
      secondLine: "Linear Connection · switch it on to see its tools",
      statusWord: "off",
      projects: [],
    });
  });

  it("joins a server to the row of its Connection, with the projects that name it", () => {
    const rows = buildMcpServerSettingsRows({
      servers: [SENTRY_HOBBY, LINEAR],
      connections: CONNECTIONS,
      plugins: OFFERING_PLUGINS,
      projects: [WEBSHOP, BLOG],
    });

    const hobby = rows.find((row) => row.connection.label === "hobby");
    const work = rows.find((row) => row.connection.label === "work");
    const linear = rows.find((row) => row.typeName === "Linear");
    expect(hobby?.view?.server.id).toBe("s-hobby");
    expect(hobby?.projects.map((project) => project.name)).toEqual(["webshop"]);
    expect(hobby?.secondLine).toBe("Sentry Connection · 2 tools");
    expect(work?.view).toBeNull();
    expect(linear?.projects.map((project) => project.name)).toEqual(["webshop", "blog"]);
  });

  it("decodes the plugins' offers once, however many rows and views it builds", () => {
    let decoded = 0;
    const [contribution] = SENTRY_PLUGIN.contributions.filter(
      (each) => each.extensionPoint === "mcp-server",
    );
    const definition = { ...(contribution!.definition as object) };
    // Reading the offer's display name is how a decode shows.
    Object.defineProperty(definition, "displayName", {
      enumerable: true,
      get: () => {
        decoded += 1;
        return "Sentry";
      },
    });
    const counted = {
      ...SENTRY_PLUGIN,
      contributions: [{ ...contribution!, definition }],
    };

    const rows = buildMcpServerSettingsRows({
      servers: [SENTRY_HOBBY],
      connections: CONNECTIONS,
      plugins: [counted],
      projects: [],
    });

    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.view !== null)?.view?.server.id).toBe("s-hobby");
    expect(decoded).toBe(1);
  });

  it("builds a switched-on server's view from the row's own pair, without matching the Connection again", () => {
    let searches = 0;
    const connections = [...CONNECTIONS];
    // The view builder finds a server's Connection by id with `find`; a row's pair is already joined.
    connections.find = () => {
      searches += 1;
      return undefined;
    };

    const rows = buildMcpServerSettingsRows({
      servers: [SENTRY_HOBBY],
      connections,
      plugins: OFFERING_PLUGINS,
      projects: [],
    });

    const hobby = rows.find((row) => row.connection.label === "hobby");
    expect(searches).toBe(0);
    expect(hobby?.view).toMatchObject({ connection: SENTRY_HOBBY_CONNECTION, account: "hobby" });
    expect(hobby?.typeName).toBe(hobby?.view?.typeName);
  });

  it("gives no row to a Connection of a type no plugin offers a server for", () => {
    const rows = buildMcpServerSettingsRows({
      servers: [],
      connections: [buildConnection("c-gh", "github/github", "octocat")],
      plugins: [SENTRY_PLUGIN],
      projects: [],
    });

    expect(rows).toEqual([]);
  });
});

const urlServer = (id: string, name: string, url: string) =>
  buildServer(id, name, "", {
    source: { kind: "url", url, signIn: "none", signInOffered: null },
  });

describe("buildUrlServerSettingsRows", () => {
  it("returns only the servers added by URL, by name, then address, whatever order they arrive in", () => {
    const rows = buildUrlServerSettingsRows({
      servers: [
        SENTRY_HOBBY,
        urlServer("s-b2", "docs", "https://b.example.com/mcp"),
        urlServer("s-z", "zeta", "https://z.example.com/mcp"),
        urlServer("s-b1", "docs", "https://a.example.com/mcp"),
        LINEAR,
      ],
      projects: [],
    });

    expect(rows.map((row) => row.view.server.id)).toEqual(["s-b1", "s-b2", "s-z"]);
  });

  it("gives each row the view with the address whole, and the projects that name it", () => {
    const docs = urlServer("s-docs", "docs", "https://docs.example.com/mcp");
    const [row] = buildUrlServerSettingsRows({
      servers: [docs, LINEAR],
      projects: [
        { ...buildProject("p-shop", "webshop"), mcpServerIds: ["s-docs", "s-linear"] },
        BLOG,
      ],
    });

    expect(row?.view).toMatchObject({
      pluginId: null,
      secondLine: "https://docs.example.com/mcp · 2 tools",
      statusWord: "ready",
    });
    expect(row?.projects.map((project) => project.name)).toEqual(["webshop"]);
  });

  it("returns no row when no server was added by URL", () => {
    expect(buildUrlServerSettingsRows({ servers: [SENTRY_HOBBY], projects: [WEBSHOP] })).toEqual(
      [],
    );
  });
});

describe("describeNamingProjects", () => {
  const names = ["a", "b", "c"].map((name) => buildProject(`p-${name}`, name));

  it("says None for no project", () => {
    expect(describeNamingProjects([])).toEqual({ kind: "none", text: "None" });
  });

  it("returns the projects as tiles for one or two", () => {
    expect(describeNamingProjects(names.slice(0, 2))).toEqual({
      kind: "tiles",
      projects: names.slice(0, 2),
    });
  });

  it("counts three or more, with their names for the tooltip", () => {
    expect(describeNamingProjects(names)).toEqual({
      kind: "count",
      text: "3 projects",
      tooltip: "a, b and c",
    });
  });
});
