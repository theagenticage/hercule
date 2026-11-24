/**
 * Writes `packages/acp/src/_generated`: the Effect Schemas of the Agent Client
 * Protocol (ACP) that `@hercule/acp` decodes and encodes messages with.
 *
 * Run it with `pnpm gen:acp-types`. It downloads the JSON Schema of two ACP
 * releases from the protocol's GitHub releases, because the client speaks both
 * generations: an agent picks one when it answers `initialize`.
 *
 * - `schema.gen.ts`: every definition of the v2 release.
 * - `schema-v1.gen.ts`: every definition of the v1 release.
 * - `meta.gen.ts`: the method names and the protocol version of the v2 release.
 *
 * The files are checked in, like the Codex types, so `pnpm typecheck` needs no
 * network. They are never edited by hand: to move to a newer ACP release,
 * change the two release constants below and run this script again.
 *
 * The functions between the two "Copied from T3 Code" markers are taken from
 * `packages/effect-acp/scripts/generate.ts` of github.com/pingdotgg/t3code
 * (MIT, see `packages/acp/LICENSE-t3code.txt`). They rewrite the JSON Schema
 * keywords that Effect's generator cannot read into ones it can.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { make as makeJsonSchemaGenerator } from "@effect/openapi-generator/JsonSchemaGenerator";
import { $ } from "bun";
import * as Schema from "effect/Schema";

/** The ACP release whose definitions become `schema.gen.ts` and `meta.gen.ts`. */
const ACP_V2_SCHEMA_RELEASE = "schema-v2.0.0-alpha.3";

/** The ACP release whose definitions become `schema-v1.gen.ts`. */
const ACP_V1_SCHEMA_RELEASE = "schema-v1.21.0";

/** Where the protocol publishes the assets of each schema release. */
const ACP_RELEASES_URL =
  "https://github.com/agentclientprotocol/agent-client-protocol/releases/download";

const root = fileURLToPath(new URL("..", import.meta.url));
const generatedFolder = `${root}packages/acp/src/_generated`;

/** The part of a release's `schema.unstable.json` that this script reads. */
const AcpJsonSchema = Schema.Struct({
  $defs: Schema.Record(Schema.String, Schema.Json),
});

/** A release's `meta.unstable.json`: its method names and its protocol version. */
const AcpReleaseMeta = Schema.Struct({
  agentMethods: Schema.Record(Schema.String, Schema.String),
  clientMethods: Schema.Record(Schema.String, Schema.String),
  version: Schema.Union([Schema.Number, Schema.String]),
});

/**
 * Returns `text` with every character that has a meaning in a regular
 * expression escaped, so that the result matches `text` literally.
 *
 * This is `RegExp.escape`, which Bun has. The ES2023 library this repository
 * compiles against does not declare it, hence the cast.
 */
const escapeRegExpCharacters = (text: string): string =>
  (RegExp as unknown as { escape: (text: string) => string }).escape(text);

// ---- Copied from T3 Code: start ----

function collectSchemaEntries(
  chunk: string,
): ReadonlyArray<{ readonly name: string; readonly code: string }> {
  const lines = chunk
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//"));
  const entries: Array<{ name: string; code: string }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const typeLine = lines[index];
    if (!typeLine?.startsWith("export type ")) {
      continue;
    }

    const constLine = lines[index + 1];
    if (!constLine?.startsWith("export const ")) {
      throw new Error(`Malformed generator output near: ${typeLine}`);
    }

    const match = /^export type ([A-Za-z0-9_]+)/.exec(typeLine);
    if (!match?.[1]) {
      throw new Error(`Could not extract schema name from: ${typeLine}`);
    }

    entries.push({
      name: match[1],
      code: `${typeLine}\n${constLine}`,
    });
    index += 1;
  }

  return entries;
}

function isJsonArray(value: Schema.Json | undefined): value is ReadonlyArray<Schema.Json> {
  return Array.isArray(value);
}

// Keywords whose values are literal JSON data, not schemas.
const DATA_KEYWORDS = new Set(["const", "default", "enum", "examples"]);

// Applies `transform` to every subschema of a schema object. `properties` maps names to
// schemas, so its keys stay property names: ACP has properties named `anyOf`, `oneOf`, and
// `type` that must not be read as keywords. Literal data values are left untouched.
function mapSubschemas(
  value: { readonly [key: string]: Schema.Json },
  transform: (schema: Schema.Json) => Schema.Json,
): Record<string, Schema.Json> {
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (DATA_KEYWORDS.has(key)) return [key, child];
      if (
        key === "properties" &&
        child !== null &&
        typeof child === "object" &&
        !isJsonArray(child)
      ) {
        return [
          key,
          Object.fromEntries(
            Object.entries(child).map(([name, schema]) => [name, transform(schema)]),
          ),
        ];
      }
      return [key, isJsonArray(child) ? child.map(transform) : transform(child)];
    }),
  );
}

function normalizeSchemaKeywords(value: Schema.Json): Schema.Json {
  if (isJsonArray(value)) {
    return value.map(normalizeSchemaKeywords);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const normalizedObject = mapSubschemas(value, normalizeSchemaKeywords);
  // ACP's forward-compatible variants exclude known discriminator values.
  // The Effect generator does not support `not`; express this exact exclusion
  // as a string pattern while preserving validation of the known variants.
  if (normalizedObject.not !== undefined) {
    const exclusion = normalizedObject.not;
    if (
      exclusion === null ||
      typeof exclusion !== "object" ||
      isJsonArray(exclusion) ||
      !isJsonArray(exclusion.anyOf)
    ) {
      throw new Error("Unsupported ACP schema exclusion");
    }
    const excluded = exclusion.anyOf.map((variant) => {
      if (variant === null || typeof variant !== "object" || isJsonArray(variant))
        throw new Error("Invalid ACP excluded variant");
      const properties = variant.properties;
      if (properties === null || typeof properties !== "object" || isJsonArray(properties))
        throw new Error("Invalid ACP excluded properties");
      const entries = Object.entries(properties);
      const entry = entries[0];
      if (entries.length !== 1 || entry === undefined) throw new Error("Invalid ACP discriminator");
      const [key, schema] = entry;
      if (
        schema === null ||
        typeof schema !== "object" ||
        isJsonArray(schema) ||
        typeof schema.const !== "string"
      )
        throw new Error("Invalid ACP discriminator value");
      return { key, value: schema.const };
    });
    const discriminator = excluded[0]?.key;
    const properties = normalizedObject.properties;
    if (
      discriminator === undefined ||
      excluded.some((entry) => entry.key !== discriminator) ||
      properties === null ||
      typeof properties !== "object" ||
      isJsonArray(properties)
    )
      throw new Error("Unsupported ACP discriminator exclusion");
    const property = properties[discriminator];
    if (property === null || typeof property !== "object" || isJsonArray(property))
      throw new Error("Missing ACP discriminator property");
    normalizedObject.properties = {
      ...properties,
      [discriminator]: {
        ...property,
        pattern: `^(?!(?:${excluded.map(({ value }) => escapeRegExpCharacters(value)).join("|")})$)[\\s\\S]*$`,
      },
    };
    delete normalizedObject.not;
  }
  if (normalizedObject.unevaluatedProperties !== undefined) {
    if (normalizedObject.unevaluatedProperties !== true)
      throw new Error("Unsupported ACP unevaluated properties constraint");
    normalizedObject.additionalProperties = true;
    delete normalizedObject.unevaluatedProperties;
  }
  if (isJsonArray(normalizedObject.oneOf)) {
    const discriminator = normalizedObject.discriminator;
    const propertyName =
      discriminator !== null && typeof discriminator === "object" && !isJsonArray(discriminator)
        ? discriminator.propertyName
        : undefined;
    const values = normalizedObject.oneOf.map((entry) => {
      if (entry === null || typeof entry !== "object" || isJsonArray(entry)) return undefined;
      if (typeof entry.const === "string") return entry.const;
      const properties = entry.properties;
      if (
        typeof propertyName !== "string" ||
        properties === null ||
        typeof properties !== "object" ||
        isJsonArray(properties)
      )
        return undefined;
      const property = properties[propertyName];
      return property !== null && typeof property === "object" && !isJsonArray(property)
        ? property.const
        : undefined;
    });
    if (
      values.every((entry) => typeof entry === "string") &&
      new Set(values).size === values.length
    ) {
      normalizedObject.anyOf = normalizedObject.oneOf;
      delete normalizedObject.oneOf;
    }
  }
  const typeValue = normalizedObject.type;

  if (!isJsonArray(typeValue)) {
    return normalizedObject;
  }

  const normalizedTypes = typeValue.filter((entry): entry is string => typeof entry === "string");
  if (normalizedTypes.length !== typeValue.length || !normalizedTypes.includes("null")) {
    return normalizedObject;
  }

  const nonNullTypes = normalizedTypes.filter((entry) => entry !== "null");
  if (nonNullTypes.length !== 1) {
    return normalizedObject;
  }
  const nonNullType = nonNullTypes[0]!;

  const nextObject: Record<string, Schema.Json> = {};
  for (const [key, child] of Object.entries(normalizedObject)) {
    if (key !== "type") {
      nextObject[key] = child;
    }
  }

  return {
    anyOf: [
      {
        ...nextObject,
        type: nonNullType,
      },
      { type: "null" },
    ],
  };
}

const isAnnotationKeyword = (key: string): boolean =>
  ["description", "title", "$comment", "default", "examples", "discriminator"].includes(key) ||
  key.startsWith("x-");

// Distribute object intersections over unions before handing schemas to Effect.
// ACP uses sibling `properties`/`anyOf` and `allOf` references for elicitation scopes.
function flattenCompositions(
  value: Schema.Json,
  definitions: Readonly<Record<string, Schema.Json>>,
): Schema.Json {
  if (isJsonArray(value)) return value.map((child) => flattenCompositions(child, definitions));
  if (value === null || typeof value !== "object") return value;
  const normalized = mapSubschemas(value, (child) => flattenCompositions(child, definitions));
  const { allOf, anyOf, ...base } = normalized;
  const merge = (left: Schema.Json, right: Schema.Json): Schema.Json => {
    if (
      left === null ||
      typeof left !== "object" ||
      isJsonArray(left) ||
      right === null ||
      typeof right !== "object" ||
      isJsonArray(right)
    )
      throw new Error("Unsupported ACP schema intersection");
    if (typeof right.$ref === "string") {
      // Keep references when the sibling only describes the referenced schema.
      // Inlining these repeats entire protocol unions in every request schema.
      if (Object.keys(left).every(isAnnotationKeyword)) return { ...right, ...left };
      const target = definitions[right.$ref.replace("#/$defs/", "")];
      if (target === undefined) throw new Error(`Missing ACP definition ${right.$ref}`);
      return merge(left, flattenCompositions(normalizeSchemaKeywords(target), definitions));
    }
    if (isJsonArray(left.anyOf)) return { anyOf: left.anyOf.map((branch) => merge(branch, right)) };
    if (isJsonArray(right.anyOf))
      return { anyOf: right.anyOf.map((branch) => merge(left, branch)) };
    for (const key of Object.keys(left)) {
      if (key === "properties" || key === "required" || isAnnotationKeyword(key)) continue;
      if (right[key] !== undefined && JSON.stringify(left[key]) !== JSON.stringify(right[key])) {
        throw new Error(`Unsupported conflicting ACP schema constraint: ${key}`);
      }
    }
    const result = { ...left, ...right };
    if (
      left.properties &&
      right.properties &&
      typeof left.properties === "object" &&
      !isJsonArray(left.properties) &&
      typeof right.properties === "object" &&
      !isJsonArray(right.properties)
    ) {
      for (const key of Object.keys(left.properties)) {
        if (
          right.properties[key] !== undefined &&
          JSON.stringify(left.properties[key]) !== JSON.stringify(right.properties[key])
        ) {
          throw new Error(`Unsupported overlapping ACP schema property: ${key}`);
        }
      }
      result.properties = { ...left.properties, ...right.properties };
    }
    if (isJsonArray(left.required) || isJsonArray(right.required)) {
      result.required = [
        ...new Set([
          ...(isJsonArray(left.required) ? left.required : []),
          ...(isJsonArray(right.required) ? right.required : []),
        ]),
      ];
    }
    return result;
  };
  let combined: Schema.Json = base;
  if (isJsonArray(allOf)) for (const part of allOf) combined = merge(combined, part);
  if (isJsonArray(anyOf) && !isJsonArray(allOf) && Object.keys(base).every(isAnnotationKeyword)) {
    return { ...base, anyOf };
  }
  return isJsonArray(anyOf) ? merge(combined, { anyOf }) : combined;
}

/**
 * Returns `schema` with `additionalProperties: false` set on every object
 * schema that does not set `additionalProperties` itself. An object schema is
 * one whose `type` is `"object"` or that lists `properties`.
 *
 * Effect's generator reads an object schema without `additionalProperties` as
 * open and emits `Schema.StructWithRest`, whose type has an index signature.
 * The client is written against plain `Schema.Struct`: T3 Code's checked-in
 * schemas are closed, although its generator script at the copied commit does
 * not close them.
 */
function closeObjectSchemas(schema: Schema.Json): Schema.Json {
  if (isJsonArray(schema)) return schema.map(closeObjectSchemas);
  if (schema === null || typeof schema !== "object") return schema;
  const closed = mapSubschemas(schema, closeObjectSchemas);
  const properties = closed.properties;
  const isObjectSchema =
    closed.type === "object" ||
    (properties !== null && typeof properties === "object" && !isJsonArray(properties));
  if (isObjectSchema && closed.additionalProperties === undefined) {
    closed.additionalProperties = false;
  }
  return closed;
}

function generateSchemaOutput(
  upstreamSchema: { readonly $defs: Readonly<Record<string, Schema.Json>> },
  release: string,
): { readonly output: string; readonly count: number } {
  const normalizedDefinitions = Object.fromEntries(
    Object.entries(upstreamSchema.$defs).map(([name, schema]) => [
      name,
      // `closeObjectSchemas` is not T3 Code's: see its docstring.
      closeObjectSchemas(
        flattenCompositions(normalizeSchemaKeywords(schema), upstreamSchema.$defs),
      ),
    ]),
  );
  const sortedEntries = Object.entries(normalizedDefinitions).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  const generatedEntries = new Map<string, string>();
  const generator = makeJsonSchemaGenerator();

  for (const [name, schema] of sortedEntries) {
    generator.addSchema(name, schema as never);
  }

  const generated = generator.generate("openapi-3.1", normalizedDefinitions as never, false).trim();
  if (generated.length > 0) {
    for (const entry of collectSchemaEntries(generated)) {
      if (!generatedEntries.has(entry.name)) {
        generatedEntries.set(entry.name, entry.code);
      }
    }
  }

  return {
    output: [
      "// Generated by scripts/gen-acp-types.ts. Never edit by hand.",
      `// Source: ${ACP_RELEASES_URL}/${release}/schema.unstable.json`,
      "",
      'import * as Schema from "effect/Schema";',
      "",
      [...generatedEntries.values()].join("\n\n"),
      "",
    ].join("\n"),
    count: generatedEntries.size,
  };
}

// ---- Copied from T3 Code: end ----

/**
 * Downloads one asset of an ACP schema release and returns it as parsed JSON.
 * Fails when GitHub does not answer with a success status.
 */
const downloadReleaseAsset = async (release: string, asset: string): Promise<unknown> => {
  const url = `${ACP_RELEASES_URL}/${release}/${asset}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
};

/**
 * Formats TypeScript source with oxfmt and returns the result.
 *
 * The source goes through stdin under a file name outside the generated
 * folder: oxfmt skips that folder (`.oxfmtrc.json`), and it returns a file it
 * skips unchanged.
 */
const formatTypeScript = (source: string): Promise<string> =>
  $`pnpm exec oxfmt --stdin-filepath=gen-acp-types.output.ts < ${new Response(source)}`
    .cwd(root)
    .text();

const [v2JsonSchema, v1JsonSchema, v2Meta] = await Promise.all([
  downloadReleaseAsset(ACP_V2_SCHEMA_RELEASE, "schema.unstable.json"),
  downloadReleaseAsset(ACP_V1_SCHEMA_RELEASE, "schema.unstable.json"),
  downloadReleaseAsset(ACP_V2_SCHEMA_RELEASE, "meta.unstable.json"),
]);

const v2 = generateSchemaOutput(
  Schema.decodeUnknownSync(AcpJsonSchema)(v2JsonSchema),
  ACP_V2_SCHEMA_RELEASE,
);
const v1 = generateSchemaOutput(
  Schema.decodeUnknownSync(AcpJsonSchema)(v1JsonSchema),
  ACP_V1_SCHEMA_RELEASE,
);
const meta = Schema.decodeUnknownSync(AcpReleaseMeta)(v2Meta);

const sources = {
  "schema.gen.ts": v2.output,
  "schema-v1.gen.ts": v1.output,
  "meta.gen.ts": [
    "// Generated by scripts/gen-acp-types.ts. Never edit by hand.",
    `// Source: ${ACP_RELEASES_URL}/${ACP_V2_SCHEMA_RELEASE}/meta.unstable.json`,
    "",
    `export const AGENT_METHODS = ${JSON.stringify(meta.agentMethods)} as const;`,
    "",
    `export const CLIENT_METHODS = ${JSON.stringify(meta.clientMethods)} as const;`,
    "",
    `export const PROTOCOL_VERSION = ${JSON.stringify(meta.version)} as const;`,
    "",
  ].join("\n"),
};

// Every file is formatted before the old ones are deleted, so a failure above
// leaves the checked-in files as they were.
const formattedSources = await Promise.all(
  Object.entries(sources).map(
    async ([fileName, source]) => [fileName, await formatTypeScript(source)] as const,
  ),
);

rmSync(generatedFolder, { recursive: true, force: true });
mkdirSync(generatedFolder, { recursive: true });
for (const [fileName, source] of formattedSources) {
  writeFileSync(`${generatedFolder}/${fileName}`, source);
}

console.log(`Wrote ${v2.count} ACP v2 schemas and ${v1.count} ACP v1 schemas.`);
