import {
  Node,
  SyntaxKind,
  type Identifier,
  type Project,
  type PropertyAccessExpression,
  type QualifiedName,
  type SourceFile,
} from 'ts-morph';
import type { Change, ManualItem, Migration, MigrationResult, PackageManifest } from '../../core/types.js';
import {
  APP_MODULE,
  CREDENTIAL_FACTORIES,
  REMOVED_SERVICES,
  ROOT_TYPES,
  SERVICES,
} from './mapping.js';

const PKG = 'firebase-admin';
const NODE_RUNTIME_GUIDANCE = 'firebase-admin v14 requires Node.js 22 or later; package.json does not declare engines.node. Add `"engines": { "node": ">=22" }` or use `--node-runtime 22` after confirming the deployment runtime.';

type AliasKind = 'esm' | 'cjs';

interface Alias {
  name: string;
  kind: AliasKind;
  nameNode: Identifier;
}

interface NeededImport {
  module: string;
  name: string;
  typeOnly: boolean;
}

interface Edit {
  start: number;
  end: number;
  text: string;
  rule: string;
  before: string;
  line: number;
  imports: NeededImport[];
}

interface TextEdit {
  start: number;
  end: number;
  text: string;
}

type Classification = { node: Node; text: string; rule: string; imports: NeededImport[] } | { reason: string };

export const firebaseAdminV14: Migration = {
  id: 'firebase-admin@14',
  packageName: PKG,
  fromMajor: 13,
  toMajor: 14,
  releasedAt: '2026-06-08',
  title: 'firebase-admin v13 → v14 (namespaced API removed)',
  guideUrl: 'https://firebase.google.com/docs/admin/migrate-node-v10',
  rules: ['service-getter', 'service-static', 'credential-factory', 'app-lifecycle', 'type'],

  inspectManifest(manifest: PackageManifest): string[] {
    const notes: string[] = [];
    const nodeRange = manifest.engines?.node;
    if (nodeRange === undefined) notes.push(NODE_RUNTIME_GUIDANCE);
    else if (typeof nodeRange !== 'string' || !supportsNode22(nodeRange)) {
      notes.push(`firebase-admin v14 requires Node.js 22 or later; review \`engines.node\` (${String(nodeRange)}).`);
    }
    const functionsTest = [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies, manifest.optionalDependencies]
      .map((dependencies) => dependencies?.['firebase-functions-test'])
      .find((value): value is string => typeof value === 'string');
    if (functionsTest) notes.push(`firebase-functions-test "${functionsTest}" is installed. In a benchmarked project, the v14 typecheck failed because this package's declarations import firebase-admin exports removed in v14 (including app and firestore). Check whether a compatible release is available; otherwise update the test setup, then rerun the tests before upgrading.`);
    return notes;
  },

  transform(project: Project): MigrationResult {
    const result: MigrationResult = { changes: [], manual: [], filesChanged: [], fileUpdates: [] };
    for (const sourceFile of project.getSourceFiles()) {
      const parseDiagnostics = (sourceFile.compilerNode as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [];
      if (parseDiagnostics.length > 0) {
        result.manual.push({
          file: sourceFile.getFilePath(),
          line: 1,
          reason: 'This source file has syntax errors and could not be analyzed safely.',
          snippet: sourceFile.getFullText().split(/\r?\n/, 1)[0] ?? '',
        });
        continue;
      }
      if (migrateFile(sourceFile, result)) result.filesChanged.push(sourceFile.getFilePath());
    }
    return result;
  },

  updateManifest(manifest: PackageManifest): string[] {
    const notes: string[] = [];
    const engine = manifest.engines?.node;
    const runtimeReady = typeof engine === 'string' && supportsNode22(engine);
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      const deps = manifest[field];
      const current = deps?.[PKG];
      if (!current) continue;
      const major = current.match(/(?:^|[^\d])(\d+)(?:\.|$)/)?.[1];
      if (!major) {
        notes.push(`Could not safely interpret \`${field}.${PKG}\` range \`${current}\`; update it to \`^14.0.0\` manually if appropriate.`);
      } else if (Number(major) === 13 && /^\s*[~^]?13(?:\.(?:\d+|x|\*)){0,2}\s*$/i.test(current)) {
        if (runtimeReady) {
          notes.push(`\`${field}.${PKG}\`: \`${current}\` → \`^14.0.0\``);
          deps[PKG] = '^14.0.0';
        } else {
          notes.push(`\`${field}.${PKG}\` was left unchanged: firebase-admin v14 requires Node.js 22 or newer. Add \`"engines": { "node": ">=22" }\` to package.json, or use \`--node-runtime 22\` to confirm your deployment runtime and include it in the proposed change.`);
        }
      } else if (Number(major) < 13) {
        notes.push(`\`${field}.${PKG}\` is on major ${major}; this migration targets v13 → v14. Upgrade to v13 first, then rerun.`);
      } else if (Number(major) === 13) {
        notes.push(`Could not safely interpret \`${field}.${PKG}\` range \`${current}\`; review it and update to \`^14.0.0\` manually if appropriate.`);
      } else if (Number(major) > 14) {
        notes.push(`\`${field}.${PKG}\` is already on major ${major}; it was left unchanged to avoid downgrading it to v14.`);
      } else if (Number(major) === 14) {
        // Already on the target major; leave the range as declared.
      }
    }
    if (!engine) {
      notes.push(NODE_RUNTIME_GUIDANCE);
    } else if (!runtimeReady) {
      notes.push(`firebase-admin v14 requires Node.js 22 or later; review \`engines.node\` (${engine}).`);
    }
    const functionsVersion = manifest.dependencies?.['firebase-functions'];
    if (functionsVersion) {
      notes.push(
        `firebase-functions \`${functionsVersion}\` is installed: check that its firebase-admin peer range accepts v14 (firebase-functions#1902).`,
      );
    }
    return notes;
  },
};

function supportsNode22(range: string): boolean {
  const normalized = range.trim();
  return /^(?:>=\s*22(?:\.\d+){0,2}|(?:\^|~)\s*22(?:\.\d+){0,2}|22(?:\.\d+){0,2})$/.test(normalized);
}

function migrateFile(sourceFile: SourceFile, result: MigrationResult): boolean {
  const file = sourceFile.getFilePath();
  const manualBefore = result.manual.length;

  reportRemovedNamedImports(sourceFile, result.manual);
  reportUnsupportedReferences(sourceFile, result.manual);

  const aliases = findAliases(sourceFile);
  if (aliases.length === 0) return false;

  const edits: Edit[] = [];
  const aliasesWithManualUses = new Set<string>();

  for (const alias of aliases) {
    const variableDeclaration = alias.nameNode.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
    const variableStatement = variableDeclaration?.getVariableStatement();
    if (variableStatement?.getModifiers().some((modifier) => modifier.getKind() === SyntaxKind.ExportKeyword)) {
      aliasesWithManualUses.add(alias.name);
      result.manual.push({
        file,
        line: alias.nameNode.getStartLineNumber(),
        reason: 'This firebase-admin namespace alias is exported. Keep the public export stable, migrate its callers separately, and remove the alias only after checking downstream imports.',
        snippet: snippetOf(alias.nameNode),
      });
      continue;
    }
    if (variableStatement && variableStatement.getDeclarations().length > 1) {
      aliasesWithManualUses.add(alias.name);
      result.manual.push({
        file,
        line: alias.nameNode.getStartLineNumber(),
        reason: 'A firebase-admin require shares a declaration with other variables; split the declaration before migrating it.',
        snippet: snippetOf(alias.nameNode),
      });
      continue;
    }

    const references = alias.nameNode
      .findReferencesAsNodes()
      .filter(Node.isIdentifier)
      .filter((reference) => reference.getSourceFile() === sourceFile)
      .filter((reference) => reference !== alias.nameNode);

    for (const ref of references) {
      const classification = classify(ref);
      const line = ref.getStartLineNumber();

      if ('reason' in classification) {
        aliasesWithManualUses.add(alias.name);
        result.manual.push({ file, line, reason: classification.reason, snippet: snippetOf(ref) });
        continue;
      }

      const collision = classification.imports.find((imp) => hasImportCollision(sourceFile, imp));
      if (collision) {
        aliasesWithManualUses.add(alias.name);
        result.manual.push({
          file,
          line,
          reason: `\`${collision.name}\` is already declared in this file: rename it, then rerun.`,
          snippet: snippetOf(ref),
        });
        continue;
      }

      edits.push({
        start: classification.node.getStart(),
        end: classification.node.getEnd(),
        text: classification.text,
        rule: classification.rule,
        before: classification.node.getText(),
        line,
        imports: classification.imports.map((imp) => ({ ...imp, typeOnly: imp.typeOnly && alias.kind === 'esm' })),
      });
    }
  }

  if (edits.length === 0) {
    if (result.manual.length > manualBefore) sortManual(result.manual, manualBefore);
    return false;
  }

  const orderedEdits = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < orderedEdits.length; index++) {
    const previous = orderedEdits[index - 1]!;
    const current = orderedEdits[index]!;
    if (current.start < previous.end) {
      result.manual.push({
        file,
        line: current.line,
        reason: 'Automatic Firebase edits overlap in this file; review the nested usage manually before migrating it.',
        snippet: current.before,
      });
      sortManual(result.manual, manualBefore);
      return false;
    }
  }

  const textEdits: TextEdit[] = edits.map((edit) => ({ start: edit.start, end: edit.end, text: edit.text }));
  for (const edit of edits) {
    result.changes.push({ file, line: edit.line, rule: edit.rule, before: edit.before, after: edit.text } satisfies Change);
  }

  const importMap = mergeImports(edits.flatMap((edit) => edit.imports));
  const kind: AliasKind = aliases.some((alias) => alias.kind === 'esm') ? 'esm' : 'cjs';
  const importText = renderImports(sourceFile, kind, importMap);
  if (importText) {
    const insertion = safeImportInsertionPosition(sourceFile);
    textEdits.push({ start: insertion, end: insertion, text: importText });
  }
  textEdits.push(...aliasDeclarationRemovals(sourceFile, aliases, aliasesWithManualUses));
  const transformed = applyTextEdits(sourceFile.getFullText(), textEdits);
  if (transformed !== sourceFile.getFullText()) result.fileUpdates?.push({ file, contents: transformed });

  if (result.manual.length > manualBefore) sortManual(result.manual, manualBefore);
  return true;
}

function classify(ref: Identifier): Classification {
  const parent = ref.getParent();
  if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === ref) return classifyAccess(parent);
  if (Node.isQualifiedName(parent) && parent.getLeft() === ref) return classifyQualified(parent);
  return { reason: 'The firebase-admin namespace is used as a value (passed around or destructured).' };
}

function classifyAccess(access: PropertyAccessExpression): Classification {
  const name = access.getName();
  const outer = access.getParent();
  const isCallee = Node.isCallExpression(outer) && outer.getExpression() === access;
  const memberOf = Node.isPropertyAccessExpression(outer) && outer.getExpression() === access ? outer : undefined;

  const service = Object.hasOwn(SERVICES, name) ? SERVICES[name] : undefined;
  if (service) {
    if (isCallee) {
      return {
        node: access,
        text: service.getter,
        rule: 'service-getter',
        imports: [{ module: service.module, name: service.getter, typeOnly: false }],
      };
    }
    if (memberOf && service.statics.includes(memberOf.getName())) {
      const member = memberOf.getName();
      return {
        node: memberOf,
        text: member,
        rule: 'service-static',
        imports: [{ module: service.module, name: member, typeOnly: false }],
      };
    }
    return { reason: `\`${access.getText()}\` is not a supported pattern for this service.` };
  }

  if (Object.hasOwn(REMOVED_SERVICES, name)) return { reason: REMOVED_SERVICES[name]! };

  if (name === 'credential' && memberOf && CREDENTIAL_FACTORIES.includes(memberOf.getName())) {
    const factory = memberOf.getName();
    return {
      node: memberOf,
      text: factory,
      rule: 'credential-factory',
      imports: [{ module: APP_MODULE, name: factory, typeOnly: false }],
    };
  }
  if (name === 'initializeApp' && isCallee) {
    return { node: access, text: 'initializeApp', rule: 'app-lifecycle', imports: [appImport('initializeApp')] };
  }
  if (name === 'app' && isCallee) {
    const appCall = outer;
    if (Node.isCallExpression(appCall)) {
      if (appCall.getArguments().length > 0) {
        return { reason: 'Named-app calls such as admin.app(name) need a manual modular API mapping.' };
      }
      const serviceAccess = appCall.getParent();
      const serviceCall = serviceAccess?.getParent();
      if (
        Node.isPropertyAccessExpression(serviceAccess) &&
        serviceAccess.getExpression() === appCall &&
        Node.isCallExpression(serviceCall) &&
        serviceCall.getExpression() === serviceAccess
      ) {
        const serviceName = serviceAccess.getName();
        const nestedService = Object.hasOwn(SERVICES, serviceName) ? SERVICES[serviceName] : undefined;
        if (nestedService) {
          return {
            node: serviceCall,
            text: `${nestedService.getter}()`,
            rule: 'app-service-getter',
            imports: [{ module: nestedService.module, name: nestedService.getter, typeOnly: false }],
          };
        }
      }
    }
    return { node: access, text: 'getApp', rule: 'app-lifecycle', imports: [appImport('getApp')] };
  }
  if (name === 'apps') {
    return { node: access, text: 'getApps()', rule: 'app-lifecycle', imports: [appImport('getApps')] };
  }
  return { reason: `\`${access.getText()}\` has no automatic mapping yet.` };
}

function classifyQualified(qualified: QualifiedName): Classification {
  const name = qualified.getRight().getText();
  const outer = qualified.getParent();

  if (ROOT_TYPES.includes(name)) {
    return { node: qualified, text: name, rule: 'type', imports: [{ module: PKG, name, typeOnly: true }] };
  }

  const service = Object.hasOwn(SERVICES, name) ? SERVICES[name] : undefined;
  if (service && Node.isQualifiedName(outer) && outer.getLeft() === qualified) {
    const typeName = outer.getRight().getText();
    if (service.removedTypes?.includes(typeName)) {
      return { reason: `\`${outer.getText()}\` was removed in v14 (legacy FCM API): use \`Message\` with \`send()\`.` };
    }
    return {
      node: outer,
      text: typeName,
      rule: 'type',
      imports: [{ module: service.module, name: typeName, typeOnly: !service.statics.includes(typeName) }],
    };
  }
  return { reason: `Type \`${qualified.getText()}\` has no automatic mapping yet.` };
}

function appImport(name: string): NeededImport {
  return { module: APP_MODULE, name, typeOnly: false };
}

function findAliases(sourceFile: SourceFile): Alias[] {
  const aliases: Alias[] = [];

  for (const decl of sourceFile.getImportDeclarations()) {
    if (decl.getModuleSpecifierValue() !== PKG) continue;
    const namespaceImport = decl.getNamespaceImport();
    const defaultImport = decl.getDefaultImport();
    if (namespaceImport) aliases.push({ name: namespaceImport.getText(), kind: 'esm', nameNode: namespaceImport });
    if (defaultImport) aliases.push({ name: defaultImport.getText(), kind: 'esm', nameNode: defaultImport });
  }

  for (const decl of sourceFile.getDescendantsOfKind(SyntaxKind.ImportEqualsDeclaration)) {
    const moduleReference = decl.getModuleReference();
    if (Node.isExternalModuleReference(moduleReference)) {
      const expression = moduleReference.getExpression();
      if (Node.isStringLiteral(expression) && expression.getLiteralValue() === PKG) {
        aliases.push({ name: decl.getName(), kind: 'esm', nameNode: decl.getNameNode() });
      }
    }
  }

  for (const decl of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = decl.getInitializer();
    const nameNode = decl.getNameNode();
    if (!Node.isIdentifier(nameNode) || !init || !Node.isCallExpression(init)) continue;
    if (init.getExpression().getText() !== 'require') continue;
    const [arg] = init.getArguments();
    if (Node.isStringLiteral(arg) && arg.getLiteralValue() === PKG) {
      aliases.push({ name: nameNode.getText(), kind: 'cjs', nameNode });
    }
  }
  return aliases;
}

/** `import { firestore } from 'firebase-admin'` relied on namespace exports that no longer exist. */
function reportRemovedNamedImports(sourceFile: SourceFile, manual: ManualItem[]): void {
  for (const decl of sourceFile.getImportDeclarations()) {
    if (decl.getModuleSpecifierValue() !== PKG) continue;
    for (const spec of decl.getNamedImports()) {
      const name = spec.getName();
      if (
        Object.hasOwn(SERVICES, name) ||
        name === 'credential' ||
        Object.hasOwn(REMOVED_SERVICES, name) ||
        name === 'app' ||
        name === 'apps'
      ) {
        manual.push({
          file: sourceFile.getFilePath(),
          line: spec.getStartLineNumber(),
          reason: `\`${name}\` is no longer exported by firebase-admin v14: import from the modular entry point instead.`,
          snippet: decl.getText(),
        });
      }
    }
  }
}

function reportUnsupportedReferences(sourceFile: SourceFile, manual: ManualItem[]): void {
  const file = sourceFile.getFilePath();
  const knownRequireAliases = new Set(
    findAliases(sourceFile).filter((alias) => alias.kind === 'cjs').map((alias) => alias.name),
  );

  for (const declaration of sourceFile.getImportDeclarations()) {
    if (declaration.getModuleSpecifierValue() !== PKG) continue;
    const specs = declaration.getNamedImports();
    if ((declaration.getDefaultImport() || declaration.getNamespaceImport()) && specs.length > 0) {
      manual.push({
        file,
        line: declaration.getStartLineNumber(),
        reason: 'A mixed default/namespace and named import from firebase-admin is not rewritten automatically.',
        snippet: declaration.getText(),
      });
    }
    const unsupportedNamedImport = specs.some((spec) => {
      const name = spec.getName();
      return !(
        ROOT_TYPES.includes(name) ||
        Object.hasOwn(SERVICES, name) ||
        name === 'credential' ||
        Object.hasOwn(REMOVED_SERVICES, name) ||
        name === 'app' ||
        name === 'apps'
      );
    });
    if (
      (specs.length === 0 && !declaration.getDefaultImport() && !declaration.getNamespaceImport()) ||
      unsupportedNamedImport
    ) {
      manual.push({
        file,
        line: declaration.getStartLineNumber(),
        reason: 'This import form from the firebase-admin root package is not migrated automatically; review it against the v14 modular API.',
        snippet: declaration.getText(),
      });
    }
  }

  for (const declaration of sourceFile.getExportDeclarations()) {
    if (declaration.getModuleSpecifierValue() !== PKG) continue;
    manual.push({
      file,
      line: declaration.getStartLineNumber(),
      reason: 'Re-exports from the firebase-admin root package are not migrated automatically.',
      snippet: declaration.getText(),
    });
  }

  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expression = call.getExpression();
    const [argument] = call.getArguments();
    const moduleSpecifier =
      Node.isStringLiteral(argument) || Node.isNoSubstitutionTemplateLiteral(argument)
        ? argument.getLiteralValue()
        : undefined;
    if (moduleSpecifier !== PKG) continue;

    if (Node.isIdentifier(expression) && expression.getText() === 'require') {
      const declaration = call.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
      const name = declaration?.getNameNode();
      if (Node.isIdentifier(name) && knownRequireAliases.has(name.getText())) continue;
      manual.push({
        file,
        line: call.getStartLineNumber(),
        reason: 'Inline or destructured require("firebase-admin") calls are not migrated automatically.',
        snippet: snippetOf(call),
      });
    } else if (expression.getKind() === SyntaxKind.ImportKeyword) {
      manual.push({
        file,
        line: call.getStartLineNumber(),
        reason: 'Dynamic import("firebase-admin") calls are not migrated automatically.',
        snippet: snippetOf(call),
      });
    }
  }
}

function hasImportCollision(sourceFile: SourceFile, needed: NeededImport): boolean {
  for (const declaration of sourceFile.getImportDeclarations()) {
    const module = declaration.getModuleSpecifierValue();
    const defaultImport = declaration.getDefaultImport();
    const namespaceImport = declaration.getNamespaceImport();
    if (defaultImport?.getText() === needed.name || namespaceImport?.getText() === needed.name) {
      if (module !== needed.module) return true;
      return true;
    }
    for (const specifier of declaration.getNamedImports()) {
      const localName = (specifier.getAliasNode() ?? specifier.getNameNode()).getText();
      if (localName !== needed.name) continue;
      if (module !== needed.module) return true;
      if (!needed.typeOnly && (declaration.isTypeOnly() || specifier.isTypeOnly())) return true;
    }
  }
  return sourceFile.getDescendantsOfKind(SyntaxKind.Identifier).some((identifier) => {
    if (identifier.getText() !== needed.name) return false;
    const parent = identifier.getParent();
    if (Node.isImportClause(parent) || Node.isNamespaceImport(parent) || Node.isImportSpecifier(parent)) return false;
    if (Node.isVariableDeclaration(parent)) return parent.getNameNode() === identifier;
    if (Node.isParameterDeclaration(parent)) return parent.getNameNode() === identifier;
    if (Node.isFunctionDeclaration(parent) || Node.isFunctionExpression(parent)) return parent.getNameNode() === identifier;
    if (Node.isClassDeclaration(parent) || Node.isInterfaceDeclaration(parent) || Node.isTypeAliasDeclaration(parent) || Node.isEnumDeclaration(parent)) {
      return parent.getNameNode() === identifier;
    }
    if (Node.isImportClause(parent)) return parent.getDefaultImport() === identifier;
    if (Node.isNamespaceImport(parent)) return parent.getNameNode() === identifier;
    if (Node.isImportSpecifier(parent)) return (parent.getAliasNode() ?? parent.getNameNode()) === identifier;
    if (Node.isBindingElement(parent)) return parent.getNameNode() === identifier;
    if (Node.isTypeParameterDeclaration(parent)) return parent.getNameNode() === identifier;
    return false;
  });
}

function applyTextEdits(source: string, edits: TextEdit[]): string {
  let result = source;
  for (const edit of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

function mergeImports(imports: NeededImport[]): Map<string, Map<string, boolean>> {
  const byModule = new Map<string, Map<string, boolean>>();
  for (const imp of imports) {
    const names = byModule.get(imp.module) ?? new Map<string, boolean>();
    // A name used both as a value and as a type must be a value import.
    names.set(imp.name, (names.get(imp.name) ?? true) && imp.typeOnly);
    byModule.set(imp.module, names);
  }
  return byModule;
}

function renderImports(
  sourceFile: SourceFile,
  kind: AliasKind,
  byModule: Map<string, Map<string, boolean>>,
): string {
  const quote = importQuote(sourceFile);
  const lines: string[] = [];
  for (const module of [...byModule.keys()].sort()) {
    const names = byModule.get(module)!;
    const missing = [...names.entries()]
      .filter(([name]) => !hasExactNamedImport(sourceFile, module, name))
      .sort(([left], [right]) => left.localeCompare(right));
    if (missing.length === 0) continue;
    if (kind === 'cjs') {
      lines.push(`const { ${missing.map(([name]) => name).join(', ')} } = require(${quote}${module}${quote});`);
      continue;
    }
    const values = missing.filter(([, typeOnly]) => !typeOnly).map(([name]) => name);
    const types = missing.filter(([, typeOnly]) => typeOnly).map(([name]) => name);
    if (values.length > 0) lines.push(`import { ${values.join(', ')} } from ${quote}${module}${quote};`);
    if (types.length > 0) lines.push(`import type { ${types.join(', ')} } from ${quote}${module}${quote};`);
  }
  if (lines.length === 0) return '';
  const fullText = sourceFile.getFullText();
  const position = safeImportInsertionPosition(sourceFile);
  const newline = fullText.includes('\r\n') ? '\r\n' : '\n';
  const before = fullText.slice(0, position);
  const after = fullText.slice(position);
  const prefix = before.endsWith('\n') ? '' : newline;
  const suffix = after.startsWith('\n') ? '' : newline;
  return `${prefix}${lines.join(newline)}${suffix}`;
}

function safeImportInsertionPosition(sourceFile: SourceFile): number {
  const imports = sourceFile.getImportDeclarations();
  if (imports.length > 0) return imports[0]!.getStart();
  const statements = sourceFile.getStatements();
  let index = 0;
  while (index < statements.length) {
    const statement = statements[index]!;
    if (Node.isExpressionStatement(statement) && Node.isStringLiteral(statement.getExpression())) index++;
    else break;
  }
  if (index > 0) return statements[index - 1]!.getEnd();
  return statements[0]?.getStart() ?? sourceFile.getEnd();
}

function importQuote(sourceFile: SourceFile): "'" | '"' {
  const specifier = sourceFile.getImportDeclarations()[0]?.getModuleSpecifier().getText();
  if (specifier?.startsWith("'")) return "'";
  if (specifier?.startsWith('"')) return '"';
  const text = sourceFile.getFullText();
  const singleCount = (text.match(/'/g) ?? []).length;
  const doubleCount = (text.match(/"/g) ?? []).length;
  return singleCount >= doubleCount ? "'" : '"';
}

function hasExactNamedImport(sourceFile: SourceFile, module: string, name: string): boolean {
  return sourceFile.getImportDeclarations().some(
    (declaration) =>
      declaration.getModuleSpecifierValue() === module &&
      declaration.getNamedImports().some((specifier) => {
        const local = specifier.getAliasNode() ?? specifier.getNameNode();
        return local.getText() === name && specifier.getName() === name;
      }),
  );
}

function aliasDeclarationRemovals(
  sourceFile: SourceFile,
  aliases: Alias[],
  aliasesWithManualUses: Set<string>,
): TextEdit[] {
  const removals: TextEdit[] = [];
  const seen = new Set<string>();
  for (const alias of aliases) {
    if (aliasesWithManualUses.has(alias.name)) continue;
    const importDecl = alias.nameNode.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
    if (importDecl) {
      const declarationAliases = aliases.filter(
        (candidate) => candidate.nameNode.getFirstAncestorByKind(SyntaxKind.ImportDeclaration) === importDecl,
      );
      if (
        declarationAliases.length > 0 &&
        declarationAliases.every((candidate) => !aliasesWithManualUses.has(candidate.name)) &&
        importDecl.getNamedImports().length === 0
      ) {
        const key = `${importDecl.getStart()}:${importDecl.getEnd()}`;
        if (!seen.has(key)) removals.push({ start: importDecl.getStart(), end: importDecl.getEnd(), text: '' });
        seen.add(key);
      }
      continue;
    }
    const importEquals = alias.nameNode.getFirstAncestorByKind(SyntaxKind.ImportEqualsDeclaration);
    const variable = alias.nameNode.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
    const statement = variable?.getVariableStatement();
    const removable = importEquals ?? (statement?.getDeclarations().length === 1 ? statement : undefined);
    if (removable) {
      const key = `${removable.getStart()}:${removable.getEnd()}`;
      if (!seen.has(key)) removals.push({ start: removable.getStart(), end: removable.getEnd(), text: '' });
      seen.add(key);
    }
  }
  return removals;
}

function snippetOf(node: Node): string {
  const statement = node.getFirstAncestor((n) => Node.isStatement(n)) ?? node;
  const text = statement.getText().split('\n')[0].trim();
  return text.length > 120 ? text.slice(0, 117) + '...' : text;
}

function sortManual(manual: ManualItem[], from: number): void {
  const tail = manual.splice(from).sort((a, b) => a.line - b.line);
  manual.push(...tail);
}
