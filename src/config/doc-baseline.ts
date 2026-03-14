import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ChannelPlugin } from "../channels/plugins/index.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import { FIELD_HELP } from "./schema.help.js";
import { buildConfigSchema, type ConfigSchemaResponse } from "./schema.js";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type JsonSchemaNode = Record<string, unknown>;

type JsonSchemaObject = JsonSchemaNode & {
  type?: string | string[];
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  additionalProperties?: JsonSchemaObject | boolean;
  items?: JsonSchemaObject | JsonSchemaObject[];
  enum?: unknown[];
  default?: unknown;
  deprecated?: boolean;
};

export type ConfigDocBaselineKind = "core" | "channel" | "plugin";

export type ConfigDocBaselineEntry = {
  path: string;
  kind: ConfigDocBaselineKind;
  type?: string | string[];
  required: boolean;
  enumValues?: JsonValue[];
  defaultValue?: JsonValue;
  deprecated: boolean;
  sensitive: boolean;
  tags: string[];
  label?: string;
  help?: string;
  hasChildren: boolean;
};

export type ConfigDocBaseline = {
  generatedBy: "scripts/generate-config-doc-baseline.ts";
  entries: ConfigDocBaselineEntry[];
};

export type ConfigDocBaselineStatefileRender = {
  jsonl: string;
  baseline: ConfigDocBaseline;
};

export type ConfigDocBaselineStatefileWriteResult = {
  changed: boolean;
  wrote: boolean;
  statefilePath: string;
};

const GENERATED_BY = "scripts/generate-config-doc-baseline.ts" as const;
const DEFAULT_STATEFILE_OUTPUT = "docs/.generated/config-baseline.jsonl";
function resolveRepoRoot(): string {
  const fromPackage = resolveOpenClawPackageRootSync({
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    moduleUrl: import.meta.url,
  });
  if (fromPackage) {
    return fromPackage;
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function normalizeBaselinePath(rawPath: string): string {
  return rawPath
    .trim()
    .replace(/\[\]/g, ".*")
    .replace(/\[(\*|\d+)\]/g, ".*")
    .replace(/^\.+|\.+$/g, "")
    .replace(/\.+/g, ".");
}

function normalizeJsonValue(value: unknown): JsonValue | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    const normalized = value
      .map((entry) => normalizeJsonValue(entry))
      .filter((entry): entry is JsonValue => entry !== undefined);
    return normalized;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => {
      const normalized = normalizeJsonValue(entry);
      return normalized === undefined ? null : ([key, normalized] as const);
    })
    .filter((entry): entry is readonly [string, JsonValue] => entry !== null);

  return Object.fromEntries(entries);
}

function normalizeEnumValues(values: unknown[] | undefined): JsonValue[] | undefined {
  if (!values) {
    return undefined;
  }
  const normalized = values
    .map((entry) => normalizeJsonValue(entry))
    .filter((entry): entry is JsonValue => entry !== undefined);
  return normalized.length > 0 ? normalized : undefined;
}

function asSchemaObject(value: unknown): JsonSchemaObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonSchemaObject;
}

function schemaHasChildren(schema: JsonSchemaObject): boolean {
  if (schema.properties && Object.keys(schema.properties).length > 0) {
    return true;
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    return true;
  }
  if (Array.isArray(schema.items)) {
    return schema.items.some((entry) => typeof entry === "object" && entry !== null);
  }
  return Boolean(schema.items && typeof schema.items === "object");
}

function resolveEntryKind(configPath: string): ConfigDocBaselineKind {
  if (configPath.startsWith("channels.")) {
    return "channel";
  }
  if (configPath.startsWith("plugins.entries.")) {
    return "plugin";
  }
  return "core";
}

async function resolveFirstExistingPath(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Keep scanning for other source file variants.
    }
  }
  return null;
}

function isChannelPlugin(value: unknown): value is ChannelPlugin {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { id?: unknown; meta?: unknown; capabilities?: unknown };
  return typeof candidate.id === "string" && typeof candidate.meta === "object";
}

async function importChannelPluginModule(rootDir: string): Promise<ChannelPlugin> {
  const modulePath = await resolveFirstExistingPath([
    path.join(rootDir, "src", "channel.ts"),
    path.join(rootDir, "src", "channel.js"),
    path.join(rootDir, "src", "plugin.ts"),
    path.join(rootDir, "src", "plugin.js"),
    path.join(rootDir, "src", "index.ts"),
    path.join(rootDir, "src", "index.js"),
    path.join(rootDir, "src", "channel.mts"),
    path.join(rootDir, "src", "channel.mjs"),
    path.join(rootDir, "src", "plugin.mts"),
    path.join(rootDir, "src", "plugin.mjs"),
  ]);
  if (!modulePath) {
    throw new Error(`channel source not found under ${rootDir}`);
  }

  const imported = (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>;
  for (const value of Object.values(imported)) {
    if (isChannelPlugin(value)) {
      return value;
    }
    if (typeof value === "function" && value.length === 0) {
      const resolved = value();
      if (isChannelPlugin(resolved)) {
        return resolved;
      }
    }
  }

  throw new Error(`channel plugin export not found in ${modulePath}`);
}

async function loadBundledConfigSchemaResponse(): Promise<ConfigSchemaResponse> {
  const repoRoot = resolveRepoRoot();
  const env = {
    ...process.env,
    HOME: os.tmpdir(),
    OPENCLAW_STATE_DIR: path.join(os.tmpdir(), "openclaw-config-doc-baseline-state"),
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(repoRoot, "extensions"),
  };

  const manifestRegistry = loadPluginManifestRegistry({
    cache: false,
    env,
    config: {},
  });
  const channelPlugins = await Promise.all(
    manifestRegistry.plugins
      .filter((plugin) => plugin.origin === "bundled" && plugin.channels.length > 0)
      .map(async (plugin) => ({
        id: plugin.id,
        channel: await importChannelPluginModule(plugin.rootDir),
      })),
  );

  return buildConfigSchema({
    plugins: manifestRegistry.plugins
      .filter((plugin) => plugin.origin === "bundled")
      .map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
        description: plugin.description,
        configUiHints: plugin.configUiHints,
        configSchema: plugin.configSchema,
      })),
    channels: channelPlugins.map((entry) => ({
      id: entry.channel.id,
      label: entry.channel.meta.label,
      description: entry.channel.meta.blurb,
      configSchema: entry.channel.configSchema?.schema,
      configUiHints: entry.channel.configSchema?.uiHints,
    })),
  });
}

function walkSchema(
  schema: JsonSchemaObject,
  uiHints: ConfigSchemaResponse["uiHints"],
  pathPrefix = "",
  required = false,
  entries: ConfigDocBaselineEntry[] = [],
): ConfigDocBaselineEntry[] {
  const normalizedPath = normalizeBaselinePath(pathPrefix);
  if (normalizedPath) {
    const hint = uiHints[normalizedPath];
    entries.push({
      path: normalizedPath,
      kind: resolveEntryKind(normalizedPath),
      type: Array.isArray(schema.type) ? [...schema.type] : schema.type,
      required,
      enumValues: normalizeEnumValues(schema.enum),
      defaultValue: normalizeJsonValue(schema.default),
      deprecated: schema.deprecated === true,
      sensitive: hint?.sensitive === true,
      tags: [...(hint?.tags ?? [])].toSorted((left, right) => left.localeCompare(right)),
      label: hint?.label,
      help: hint?.help,
      hasChildren: schemaHasChildren(schema),
    });
  }

  const requiredKeys = new Set(schema.required ?? []);
  for (const key of Object.keys(schema.properties ?? {}).toSorted((left, right) =>
    left.localeCompare(right),
  )) {
    const child = asSchemaObject(schema.properties?.[key]);
    if (!child) {
      continue;
    }
    const childPath = normalizedPath ? `${normalizedPath}.${key}` : key;
    walkSchema(child, uiHints, childPath, requiredKeys.has(key), entries);
  }

  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    const wildcard = asSchemaObject(schema.additionalProperties);
    if (wildcard) {
      const wildcardPath = normalizedPath ? `${normalizedPath}.*` : "*";
      walkSchema(wildcard, uiHints, wildcardPath, false, entries);
    }
  }

  if (Array.isArray(schema.items)) {
    for (const item of schema.items) {
      const child = asSchemaObject(item);
      if (!child) {
        continue;
      }
      const itemPath = normalizedPath ? `${normalizedPath}.*` : "*";
      walkSchema(child, uiHints, itemPath, false, entries);
    }
  } else if (schema.items && typeof schema.items === "object") {
    const itemSchema = asSchemaObject(schema.items);
    if (itemSchema) {
      const itemPath = normalizedPath ? `${normalizedPath}.*` : "*";
      walkSchema(itemSchema, uiHints, itemPath, false, entries);
    }
  }

  return entries;
}

function dedupeEntries(entries: ConfigDocBaselineEntry[]): ConfigDocBaselineEntry[] {
  const byPath = new Map<string, ConfigDocBaselineEntry>();
  for (const entry of entries) {
    byPath.set(entry.path, entry);
  }
  return [...byPath.values()].toSorted((left, right) => left.path.localeCompare(right.path));
}

export async function buildConfigDocBaseline(): Promise<ConfigDocBaseline> {
  const response = await loadBundledConfigSchemaResponse();
  const schemaRoot = asSchemaObject(response.schema);
  if (!schemaRoot) {
    throw new Error("config schema root is not an object");
  }
  const entries = dedupeEntries(walkSchema(schemaRoot, response.uiHints));
  return {
    generatedBy: GENERATED_BY,
    entries,
  };
}

export async function renderConfigDocBaselineStatefile(
  baseline?: ConfigDocBaseline,
): Promise<ConfigDocBaselineStatefileRender> {
  const resolvedBaseline = baseline ?? (await buildConfigDocBaseline());
  const metadataLine = JSON.stringify({
    generatedBy: GENERATED_BY,
    recordType: "meta",
    totalPaths: resolvedBaseline.entries.length,
  });
  const entryLines = resolvedBaseline.entries.map((entry) =>
    JSON.stringify({
      recordType: "path",
      ...entry,
    }),
  );
  return {
    jsonl: `${[metadataLine, ...entryLines].join("\n")}\n`,
    baseline: resolvedBaseline,
  };
}

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function writeIfChanged(filePath: string, next: string): Promise<boolean> {
  const current = await readIfExists(filePath);
  if (current === next) {
    return false;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, next, "utf8");
  return true;
}

export async function writeConfigDocBaselineStatefile(params?: {
  repoRoot?: string;
  check?: boolean;
  statefilePath?: string;
}): Promise<ConfigDocBaselineStatefileWriteResult> {
  const repoRoot = params?.repoRoot ?? resolveRepoRoot();
  const statefilePath = path.resolve(repoRoot, params?.statefilePath ?? DEFAULT_STATEFILE_OUTPUT);
  const rendered = await renderConfigDocBaselineStatefile();
  const currentStatefile = await readIfExists(statefilePath);
  const changed = currentStatefile !== rendered.jsonl;

  if (params?.check) {
    return {
      changed,
      wrote: false,
      statefilePath,
    };
  }

  const wrote = await writeIfChanged(statefilePath, rendered.jsonl);
  return {
    changed,
    wrote,
    statefilePath,
  };
}

export function normalizeConfigDocBaselineHelpPath(pathValue: string): string {
  return normalizeBaselinePath(pathValue);
}

export function getNormalizedFieldHelp(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(FIELD_HELP)
      .map(([configPath, help]) => [normalizeBaselinePath(configPath), help] as const)
      .toSorted(([left], [right]) => left.localeCompare(right)),
  );
}
