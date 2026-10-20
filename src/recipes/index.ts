import { readFile, stat } from 'node:fs/promises';
import { createRecipeMigration, type RecipeDefinition } from './migration.js';
import { recipeSchema } from './schema.js';

const MAX_RECIPE_BYTES = 64 * 1024;
const SAFE_PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/;
const SAFE_EXPORT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const FORBIDDEN_TARGET = new Set(['arguments', 'eval', 'require', 'default', 'import', 'export', 'class', 'function', 'const', 'let', 'var', 'return', 'new', 'await', 'yield', 'this', 'super', 'null', 'true', 'false', 'switch', 'case', 'if', 'else', 'while', 'for', 'do', 'try', 'catch', 'finally', 'throw', 'delete', 'void', 'typeof', 'instanceof', 'in', 'of', 'extends', 'interface', 'enum', 'type', 'namespace', 'package', 'private', 'protected', 'public', 'static', 'implements']);
const SAFE_MODULE = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?:\/[a-z0-9][a-z0-9._-]*)*$/;
const RULE_KINDS = new Set(['export-rename', 'import-move', 'namespace-call', 'chained-namespace-call', 'namespace-property', 'method-rename', 'manual-namespace-call']);

// The same closed shape is published as docs/recipe.schema.json. No schema keyword
// contains an expression supplied by a recipe author.
const fields: Record<string, 'string' | 'number' | 'array'> = {
  schemaVersion: 'number', id: 'string', package: 'string', fromMajor: 'number',
  toMajor: 'number', releasedAt: 'string', title: 'string', guideUrl: 'string',
  nodeMajor: 'number', rules: 'array',
};
const ruleFields: Record<string, 'string'> = {
  kind: 'string', id: 'string', name: 'string', to: 'string', from: 'string',
  message: 'string', receiver: 'string', via: 'string',
};
const requiredByKind: Record<string, string[]> = {
  'export-rename': ['name', 'to'],
  'import-move': ['name', 'from'],
  'namespace-call': ['name', 'to', 'from'],
  'chained-namespace-call': ['via', 'name', 'to', 'from'],
  'namespace-property': ['name', 'to', 'from'],
  'method-rename': ['name', 'to', 'receiver'],
  'manual-namespace-call': ['name', 'message'],
};

function fail(location: string, message: string): never {
  throw new Error(`Invalid recipe at ${location}: ${message}`);
}

function objectAt(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(location, 'expected a mapping.');
  return value as Record<string, unknown>;
}

interface SchemaNode {
  type?: 'object' | 'array' | 'string' | 'integer';
  const?: unknown;
  enum?: readonly unknown[];
  required?: readonly string[];
  properties?: Record<string, SchemaNode>;
  additionalProperties?: boolean;
  items?: SchemaNode;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}

function validateJsonSchema(value: unknown, schema: SchemaNode, location: string): void {
  if (schema.const !== undefined && value !== schema.const) fail(location, `expected ${JSON.stringify(schema.const)}.`);
  if (schema.enum && !schema.enum.includes(value)) fail(location, `expected one of ${schema.enum.join(', ')}.`);
  if (schema.type === 'object') {
    const record = objectAt(value, location);
    for (const key of schema.required ?? []) if (!Object.hasOwn(record, key)) fail(`${location}.${key}`, 'is required by the JSON schema.');
    for (const [key, field] of Object.entries(record)) {
      const definition = schema.properties?.[key];
      if (!definition) {
        if (schema.additionalProperties === false) fail(`${location}.${key}`, 'unknown field.');
      } else validateJsonSchema(field, definition, `${location}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) fail(location, 'expected an array.');
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(location, `requires at least ${schema.minItems} items.`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(location, `allows at most ${schema.maxItems} items.`);
    value.forEach((item, index) => { if (schema.items) validateJsonSchema(item, schema.items, `${location}[${index}]`); });
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') fail(location, 'expected a string.');
    if (schema.minLength !== undefined && value.length < schema.minLength) fail(location, `requires at least ${schema.minLength} characters.`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) fail(location, `allows at most ${schema.maxLength} characters.`);
  } else if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value)) fail(location, 'expected an integer.');
    if (schema.minimum !== undefined && (value as number) < schema.minimum) fail(location, `must be at least ${schema.minimum}.`);
    if (schema.maximum !== undefined && (value as number) > schema.maximum) fail(location, `must be at most ${schema.maximum}.`);
  }
}

function validateRecipe(value: unknown): RecipeDefinition {
  validateJsonSchema(value, recipeSchema as unknown as SchemaNode, '$');
  const record = objectAt(value, '$');
  for (const [key, kind] of Object.entries(fields)) {
    const field = record[key];
    if (field === undefined) fail(`$.${key}`, 'is required by the JSON schema.');
    if (kind === 'array' ? !Array.isArray(field) : typeof field !== kind) fail(`$.${key}`, `expected ${kind}.`);
    if (typeof field === 'string' && (field.length === 0 || field.length > 500)) fail(`$.${key}`, 'must contain 1–500 characters.');
    if (typeof field === 'string' && /[\x00-\x1f\x7f]/.test(field)) fail(`$.${key}`, 'control characters are not allowed.');
  }
  for (const key of Object.keys(record)) if (!(key in fields)) fail(`$.${key}`, 'unknown field.');
  if (record.schemaVersion !== 1) fail('$.schemaVersion', 'only schema version 1 is supported.');
  if (!SAFE_PACKAGE.test(record.package as string)) fail('$.package', 'expected a valid npm package name without a path or URL.');
  if (!/^[a-z0-9][a-z0-9._-]*@[1-9][0-9]*$/.test(record.id as string) &&
      !/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*@[1-9][0-9]*$/.test(record.id as string)) fail('$.id', 'expected package@targetMajor.');
  if (record.id !== `${record.package}@${record.toMajor}`) fail('$.id', 'must match package and toMajor.');
  for (const key of ['fromMajor', 'toMajor', 'nodeMajor']) {
    if (!Number.isSafeInteger(record[key]) || (record[key] as number) < 1 || (record[key] as number) > 99) fail(`$.${key}`, 'expected an integer from 1 to 99.');
  }
  if ((record.toMajor as number) <= (record.fromMajor as number)) fail('$.toMajor', 'must exceed fromMajor.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(record.releasedAt as string)) fail('$.releasedAt', 'expected YYYY-MM-DD.');
  if (/[<>\[\]#*|`]/.test(record.title as string)) fail('$.title', 'Markdown or HTML markup is not allowed in the title.');
  try {
    const url = new URL(record.guideUrl as string);
    if (url.protocol !== 'https:' || url.username || url.password) fail('$.guideUrl', 'must be an HTTPS URL without credentials.');
    record.guideUrl = url.href;
  } catch { fail('$.guideUrl', 'must be an HTTPS URL without credentials.'); }
  const rules = record.rules as unknown[];
  if (rules.length < 1 || rules.length > 256) fail('$.rules', 'must contain 1–256 rules.');
  const patterns = new Set<string>();
  for (const [index, raw] of rules.entries()) {
    const location = `$.rules[${index}]`;
    const rule = objectAt(raw, location);
    for (const [key, value] of Object.entries(rule)) {
      if (!(key in ruleFields)) fail(`${location}.${key}`, 'unknown field.');
      if (typeof value !== 'string' || value.length < 1 || value.length > 500) fail(`${location}.${key}`, 'expected a string of 1–500 characters.');
      if (/[\x00-\x1f\x7f]/.test(value)) fail(`${location}.${key}`, 'control characters are not allowed.');
    }
    if (!RULE_KINDS.has(String(rule.kind))) fail(`${location}.kind`, 'unknown rule kind.');
    if (!rule.id || !/^[a-z][a-z0-9-]{0,63}$/.test(String(rule.id))) fail(`${location}.id`, 'expected a short lowercase rule identifier.');
    for (const key of requiredByKind[String(rule.kind)] ?? []) if (rule[key] === undefined) fail(`${location}.${key}`, `required for ${rule.kind}.`);
    const pattern = `${rule.kind}:${rule.via ?? ''}:${rule.name}`;
    if (patterns.has(pattern)) fail(`${location}.name`, 'duplicate rule pattern.');
    patterns.add(pattern);
    for (const key of ['name', 'to', 'receiver', 'via']) {
      if (rule[key] && key !== 'to' && !SAFE_EXPORT.test(String(rule[key]))) fail(`${location}.${key}`, 'expected a JavaScript identifier.');
    }
    if (rule.name && !SAFE_EXPORT.test(String(rule.name))) fail(`${location}.name`, 'expected a JavaScript identifier.');
    if (rule.to && !SAFE_EXPORT.test(String(rule.to)) && !(rule.kind === 'namespace-property' && /^[$A-Za-z_][$\w]*\(\)$/.test(String(rule.to)))) fail(`${location}.to`, 'expected an identifier (or a zero-argument call for namespace-property).');
    if (rule.to && FORBIDDEN_TARGET.has(String(rule.to).replace(/\(\)$/, ''))) fail(`${location}.to`, 'reserved or unsafe generated identifier.');
    if (rule.from && !SAFE_MODULE.test(String(rule.from))) fail(`${location}.from`, 'expected a package subpath, without traversal or URL.');
    if (rule.from && !(String(rule.from) === record.package || String(rule.from).startsWith(`${record.package}/`))) fail(`${location}.from`, 'must stay within the recipe package.');
    if (rule.kind === 'manual-namespace-call' && String(rule.message).length > 300) fail(`${location}.message`, 'must be at most 300 characters.');
  }
  return record as unknown as RecipeDefinition;
}

function scalar(value: string, line: number): string | number | boolean {
  if (/^[&*!>|\[{]/.test(value)) fail(`line ${line}`, 'YAML anchors, tags, blocks and flow collections are unsupported.');
  if (value.startsWith('"')) {
    try { const parsed = JSON.parse(value); if (typeof parsed === 'string') return parsed; } catch { /* clear error below */ }
    fail(`line ${line}`, 'invalid double-quoted string.');
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) fail(`line ${line}`, 'invalid single-quoted string.');
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (/^(true|false|null)$/i.test(value)) return value === 'true' ? true : value === 'false' ? false : fail(`line ${line}`, 'null is unsupported.');
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/[\x00-\x1f\x7f]/.test(value)) fail(`line ${line}`, 'control character.');
  return value;
}

type Frame = { indent: number; value: Record<string, unknown> | unknown[] };

/** Strict YAML 1-style subset: mappings, sequences of mappings, and scalar values only. */
export function parseRecipe(contents: string): ReturnType<typeof createRecipeMigration> {
  if (Buffer.byteLength(contents) > MAX_RECIPE_BYTES) throw new Error(`Recipe exceeds the ${MAX_RECIPE_BYTES}-byte size limit.`);
  const lines = contents.replace(/^\uFEFF/, '').split(/\r?\n/)
    .map((text, index) => ({ text, line: index + 1 }))
    .filter(({ text }) => text.trim() && !text.trimStart().startsWith('#'));
  const root: Record<string, unknown> = Object.create(null);
  const stack: Frame[] = [{ indent: -2, value: root }];
  for (let index = 0; index < lines.length; index++) {
    const { text, line } = lines[index]!;
    if (/\t/.test(text)) fail(`line ${line}`, 'tabs are unsupported; use two-space indentation.');
    const indent = /^ */.exec(text)![0].length;
    if (indent % 2 !== 0) fail(`line ${line}`, 'indentation must use multiples of two spaces.');
    while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const parent = stack[stack.length - 1]!;
    if (indent !== parent.indent + 2) fail(`line ${line}`, 'unexpected indentation.');
    const body = text.slice(indent);
    if (body.startsWith('- ')) {
      if (!Array.isArray(parent.value)) fail(`line ${line}`, 'sequence item must follow a list field.');
      const item: Record<string, unknown> = Object.create(null);
      parent.value.push(item);
      stack.push({ indent, value: item });
      const match = /^([A-Za-z][\w-]*): (.+)$/.exec(body.slice(2));
      if (!match) fail(`line ${line}`, 'expected “- key: value”.');
      item[match[1]!] = scalar(match[2]!, line);
      continue;
    }
    if (Array.isArray(parent.value)) fail(`line ${line}`, 'expected a list item.');
    const match = /^([A-Za-z][\w-]*):(?: (.*))?$/.exec(body);
    if (!match) fail(`line ${line}`, 'expected “key: value”.');
    const key = match[1]!;
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') fail(`line ${line}`, 'unsafe key.');
    if (Object.hasOwn(parent.value, key)) fail(`line ${line}`, `duplicate key ${key}.`);
    if (match[2] !== undefined && match[2] !== '') {
      parent.value[key] = scalar(match[2], line);
    } else {
      const next = lines[index + 1];
      if (!next) fail(`line ${line}`, 'a nested value is required.');
      const container: Record<string, unknown> | unknown[] = next.text.trimStart().startsWith('- ') ? [] : Object.create(null);
      parent.value[key] = container;
      stack.push({ indent, value: container });
    }
  }
  return createRecipeMigration(validateRecipe(root));
}

export async function loadRecipe(file: string): Promise<ReturnType<typeof createRecipeMigration>> {
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_RECIPE_BYTES) throw new Error(`Recipe must be a regular file of at most ${MAX_RECIPE_BYTES} bytes.`);
  const contents = await readFile(file, 'utf8');
  return parseRecipe(contents);
}
