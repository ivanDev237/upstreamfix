import { Node, SyntaxKind, type Project, type SourceFile, type Symbol as MorphSymbol } from 'ts-morph';
import { resolve } from 'node:path';
import type { Change, ManualItem, Migration, MigrationResult, PackageManifest } from '../../core/types.js';
import { guaranteesNodeMajor } from '../../core/node-range.js';

const GUIDE = 'https://github.com/openai/openai-node/blob/v5.0.0/MIGRATION.md';
const CHANGED_PATH_METHODS = new Set([
  'fineTuning.checkpoints.permissions.delete',
  'vectorStores.files.retrieve', 'vectorStores.files.update', 'vectorStores.files.delete',
  'vectorStores.files.content', 'vectorStores.fileBatches.retrieve', 'vectorStores.fileBatches.cancel',
  'vectorStores.fileBatches.listFiles', 'beta.threads.runs.retrieve', 'beta.threads.runs.update',
  'beta.threads.runs.cancel', 'beta.threads.runs.submitToolOutputs', 'beta.threads.runs.steps.retrieve',
  'beta.threads.runs.submitToolOutputsStream',
  'beta.threads.runs.steps.list', 'beta.threads.messages.retrieve', 'beta.threads.messages.update',
  'beta.threads.messages.delete', 'evals.runs.retrieve', 'evals.runs.delete',
  'evals.runs.cancel', 'evals.runs.outputItems.retrieve', 'evals.runs.outputItems.list',
  'containers.files.retrieve', 'containers.files.delete', 'containers.files.content.retrieve',
]);
const SAFE_NAMED_PATH_REWRITES = new Map([
  ['beta.threads.runs.retrieve', 'thread_id'],
  ['beta.threads.runs.submitToolOutputs', 'thread_id'],
  ['beta.threads.messages.retrieve', 'thread_id'],
]);
const DELETED_METHODS = new Set([
  'chat.completions.del', 'files.del', 'models.del',
  'fineTuning.checkpoints.permissions.del', 'vectorStores.del', 'vectorStores.files.del',
  'beta.assistants.del', 'beta.threads.del', 'beta.threads.messages.del',
  'responses.del', 'evals.del', 'evals.runs.del', 'containers.del', 'containers.files.del',
]);
// Most deprecated public subpaths remain exported in v5 and must stay stable.
// This nested v4 message module is the exception: v5 flattens it to messages.ts.
const MOVED_IMPORTS = new Map<string, string>([
  ['openai/resources/beta/threads/messages/messages', 'openai/resources/beta/threads/messages'],
  ['openai/resources/beta/chat/completions', 'openai/resources/chat/completions'],
]);
// These names are checked against the published openai@5.0.0 declarations.
// Unknown names are kept for manual review instead of being moved speculatively.
const V5_BETA_CHAT_COMPLETION_EXPORTS = new Set([
  'ChatCompletionStream', 'ChatCompletionStreamParams', 'ChatCompletionRunner',
  'ChatCompletionStreamingRunner', 'ChatCompletionToolRunnerParams', 'Completions',
  'ParsedChoice', 'ParsedChatCompletion', 'ParsedChatCompletionMessage', 'ParsedFunctionToolCall',
]);
const MOVED_MESSAGE_TYPES = new Map([
  ['MessageContentText', 'TextContentBlock'],
  ['ThreadMessage', 'Message'],
  ['MessageContentImageFile', 'ImageFileContentBlock'],
]);
const RUN_TOOLS_EVENTS = new Map([
  ['functionCall', 'functionToolCall'], ['functionCallResult', 'functionToolCallResult'],
  ['finalFunctionCall', 'finalFunctionToolCall'], ['finalFunctionCallResult', 'finalFunctionToolCallResult'],
]);
const RUN_TOOLS_METHODS = new Map([
  ['finalFunctionCall', 'finalFunctionToolCall'],
  ['finalFunctionCallResult', 'finalFunctionToolCallResult'],
]);
const REQUEST_OPTION_OVERLOADS = new Set([
  'chat.completions.list', 'chat.completions.messages.list', 'files.list',
  'fineTuning.jobs.list', 'fineTuning.jobs.listEvents', 'fineTuning.jobs.checkpoints.list',
  'fineTuning.checkpoints.permissions.retrieve', 'vectorStores.list', 'vectorStores.files.list',
  'beta.assistants.list', 'beta.threads.create', 'beta.threads.runs.list',
  'beta.threads.messages.list', 'batches.list', 'responses.retrieve',
  'responses.inputItems.list', 'evals.list', 'evals.runs.list',
  'containers.list', 'containers.files.list',
]);
const REQUEST_OPTION_KEYS = new Set(['headers', 'timeout', 'maxRetries', 'signal', 'idempotencyKey']);
const CLIENT_CONFIG_KEYS = new Set(['maxRetries', 'timeout', 'baseURL', 'apiKey', 'organization', 'project', 'defaultHeaders', 'defaultQuery']);
const VECTOR_STORE_POLLING_METHODS = new Set([
  'vectorStores.files.poll', 'vectorStores.fileBatches.poll',
  'vectorStores.files.uploadAndPoll', 'vectorStores.fileBatches.uploadAndPoll',
]);
const REMOVED_RUNNER_TYPES = new Set([
  'RunnableFunction', 'RunnableFunctionWithParse', 'RunnableFunctionWithoutParse',
  'ChatCompletionRunFunctionsParams',
]);
const REMOVED_UPLOAD_EXPORTS = new Set([
  'fileFromPath', 'BlobPart', 'BlobLike', 'FileLike', 'ResponseLike',
  'isResponseLike', 'isBlobLike', 'isFileLike', 'isUploadable',
  'isMultipartBody', 'maybeMultipartFormRequestOptions',
  'multipartFormRequestOptions', 'createForm',
]);
interface Edit { start: number; end: number; replacement: string; rule: string; before: string; line: number }

function pathParts(node: Node): string[] {
  const expression = unwrapTransparentExpression(node);
  if (expression !== node) return pathParts(expression);
  if (Node.isIdentifier(node)) return [node.getText()];
  if (node.getKind() === SyntaxKind.ThisKeyword) return ['this'];
  if (Node.isPropertyAccessExpression(node)) return [...pathParts(node.getExpression()), node.getName()];
  if (Node.isElementAccessExpression(node)) {
    const argument = node.getArgumentExpression();
    if (argument && Node.isStringLiteral(argument))
      return [...pathParts(node.getExpression()), argument.getText().slice(1, -1)];
    if (argument && Node.isNumericLiteral(argument))
      return [...pathParts(node.getExpression()), argument.getText()];
  }
  return [];
}

function rootIdentifier(node: Node): Node | undefined {
  const expression = unwrapTransparentExpression(node);
  if (expression !== node) return rootIdentifier(expression);
  if (Node.isIdentifier(node)) return node;
  if (node.getKind() === SyntaxKind.ThisKeyword) return node;
  if (Node.isPropertyAccessExpression(node)) return rootIdentifier(node.getExpression());
  if (Node.isElementAccessExpression(node)) return rootIdentifier(node.getExpression());
  if (Node.isQualifiedName(node)) return rootIdentifier(node.getLeft());
  return undefined;
}

function unwrapTransparentExpression(node: Node): Node {
  if (Node.isParenthesizedExpression(node) || Node.isNonNullExpression(node)
    || Node.isAsExpression(node) || Node.isTypeAssertion(node) || Node.isSatisfiesExpression(node))
    return unwrapTransparentExpression(node.getExpression());
  return node;
}

function canonicalClientSymbol(symbol: MorphSymbol): MorphSymbol {
  let current = symbol;
  const seen = new Set<MorphSymbol>();
  while (!seen.has(current)) {
    seen.add(current);
    const target = current.getAliasedSymbol();
    if (!target || target.getDeclarations().length === 0) break;
    current = target;
  }
  return current;
}

function isAffectedMethod(method: string): boolean {
  return DELETED_METHODS.has(method) || CHANGED_PATH_METHODS.has(method) || SAFE_NAMED_PATH_REWRITES.has(method);
}

function isAffectedWritePath(method: string): boolean {
  if (isAffectedMethod(method)) return true;
  if ([...DELETED_METHODS].some((deleted) => method === `${deleted.slice(0, deleted.lastIndexOf('.'))}.delete`)) return true;
  return [...RUN_TOOLS_METHODS.values()].includes(method.split('.').at(-1) ?? '');
}

function hasDuplicateMovedSpecifier(file: SourceFile, specifier: string): boolean {
  const source = file.getFullText();
  const occurrences = source.split(specifier).length - 1;
  const staticImports = file.getImportDeclarations().filter((item) => item.getModuleSpecifierValue() === specifier).length
    + file.getExportDeclarations().filter((item) => item.getModuleSpecifierValue() === specifier).length
    + file.getDescendantsOfKind(SyntaxKind.ImportType).filter((item) => item.getArgument().getText().replace(/^['"]|['"]$/g, '') === specifier).length;
  return occurrences > staticImports;
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function mentionsIdentifier(text: string, identifier: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegExp(identifier)}($|[^A-Za-z0-9_$])`).test(text);
}

function isOpenAiSpecifier(specifier: string): boolean {
  return specifier === 'openai' || specifier.startsWith('openai/');
}

function moduleSpecifierLiteral(node: Node | undefined): string | undefined {
  if (node && Node.isStringLiteral(node)) return node.getLiteralValue();
  if (node && Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralText();
  return undefined;
}

function isLocalOpenAiAlias(specifier: string): boolean {
  return !['@langchain/openai', '@ai-sdk/openai', 'openai-edge'].includes(specifier)
    && (specifier.startsWith('.') || specifier.startsWith('@/') || specifier.startsWith('#'))
    && /(?:^|\/)openai$/.test(specifier);
}

function hasOpenAiSpecifierEvidence(file: SourceFile): boolean {
  return file.getImportDeclarations().some((declaration) => isOpenAiSpecifier(declaration.getModuleSpecifierValue()))
    || file.getDescendantsOfKind(SyntaxKind.CallExpression).some((call) => {
      const argument = call.getArguments()[0];
      const specifier = moduleSpecifierLiteral(argument);
      return (call.getExpression().getText() === 'require' || call.getExpression().getKind() === SyntaxKind.ImportKeyword)
        && specifier !== undefined && isOpenAiSpecifier(specifier);
    });
}

function affectedSuffix(parts: readonly string[]): string | undefined {
  for (let start = 0; start < parts.length; start++) {
    const suffix = parts.slice(start).join('.');
    if (isAffectedMethod(suffix) || (suffix.split('.').length >= 2
      && [...DELETED_METHODS.keys(), ...CHANGED_PATH_METHODS.keys(), ...SAFE_NAMED_PATH_REWRITES.keys()].some((method) => method.endsWith(`.${suffix}`)))) return suffix;
  }
  return undefined;
}

export function hasAffectedOpenAiV5Call(file: SourceFile): boolean {
  if (file.getImportDeclarations().some((declaration) => MOVED_IMPORTS.has(declaration.getModuleSpecifierValue()))
    || file.getExportDeclarations().some((declaration) => MOVED_IMPORTS.has(declaration.getModuleSpecifierValue() ?? ''))
    || file.getDescendantsOfKind(SyntaxKind.ImportType).some((node) =>
      MOVED_IMPORTS.has(node.getArgument().getText().replace(/^['"]|['"]$/g, '')))) return true;
  return file.getDescendantsOfKind(SyntaxKind.CallExpression).some((call) => {
    const expression = call.getExpression();
    if ((expression.getText() === 'require' || expression.getKind() === SyntaxKind.ImportKeyword)
      && MOVED_IMPORTS.has(moduleSpecifierLiteral(call.getArguments()[0]) ?? '')) return true;
    const parts = pathParts(call.getExpression());
    return Boolean(affectedSuffix(parts)) || parts.join('.').includes('beta.chat.completions')
      || RUN_TOOLS_METHODS.has(parts.at(-1) ?? '');
  });
}

function partsAfterLastComputedAccess(node: Node): string[] {
  const expression = unwrapTransparentExpression(node);
  if (expression !== node) return partsAfterLastComputedAccess(expression);
  if (Node.isIdentifier(expression)) return [];
  if (Node.isPropertyAccessExpression(expression))
    return [...partsAfterLastComputedAccess(expression.getExpression()), expression.getName()];
  if (Node.isElementAccessExpression(expression)) {
    const argument = expression.getArgumentExpression();
    if (argument && Node.isStringLiteral(argument))
      return [...partsAfterLastComputedAccess(expression.getExpression()), argument.getLiteralValue()];
    return [];
  }
  return [];
}

function addManual(result: MigrationResult, file: SourceFile, node: Node, reason: string): void {
  result.manual.push({ file: file.getFilePath(), line: file.getLineAndColumnAtPos(node.getStart()).line,
    reason, snippet: node.getText().slice(0, 500),
    ...(Node.isCallExpression(node) ? { reasonCode: 'openai-affected-call' as const } : {}) });
}

function addEdit(edits: Edit[], file: SourceFile, node: Node, replacement: string, rule: string): void {
  edits.push({ start: node.getStart(), end: node.getEnd(), before: node.getText(), replacement, rule,
    line: file.getLineAndColumnAtPos(node.getStart()).line });
}

function directlyConstructedOpenAIExports(project: Project): Map<string, Set<string>> {
  const exported = new Map<string, Set<string>>();
  for (const source of project.getSourceFiles()) {
    const constructors = new Set<string>();
    for (const declaration of source.getImportDeclarations()) {
      if (declaration.getModuleSpecifierValue() !== 'openai') continue;
      const defaultImport = declaration.getDefaultImport();
      if (defaultImport) constructors.add(defaultImport.getText());
      for (const named of declaration.getNamedImports()) {
        if (named.getName() === 'OpenAI' || named.getName() === 'AzureOpenAI')
          constructors.add(named.getAliasNode()?.getText() ?? named.getName());
      }
    }
    if (constructors.size === 0) continue;
    const locals = new Set<string>();
    for (const variable of source.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      if (!Node.isIdentifier(variable.getNameNode())) continue;
      const initializer = variable.getInitializer();
      if (!initializer || !Node.isNewExpression(initializer) || !Node.isIdentifier(initializer.getExpression())
        || !constructors.has(initializer.getExpression().getText())) continue;
      locals.add(variable.getName());
    }
    const exportedLocals = new Set<string>();
    for (const variable of source.getVariableDeclarations()) {
      const statement = variable.getParentIfKind(SyntaxKind.VariableDeclarationList)?.getParentIfKind(SyntaxKind.VariableStatement);
      if (Node.isIdentifier(variable.getNameNode()) && statement?.getModifiers().some((modifier) => modifier.getKind() === SyntaxKind.ExportKeyword))
        exportedLocals.add(variable.getName());
    }
    const exportAliases = new Set<string>();
    for (const declaration of source.getExportDeclarations()) {
      if (declaration.getModuleSpecifierValue()) continue;
      for (const element of declaration.getNamedExports()) {
        const local = element.getNameNode().getText();
        if (!locals.has(local)) continue;
        exportedLocals.add(local);
        exportAliases.add(element.getAliasNode()?.getText() ?? local);
      }
    }
    for (const assignment of source.getExportAssignments()) {
      if (!assignment.isExportEquals() && Node.isIdentifier(assignment.getExpression())
        && locals.has(assignment.getExpression().getText())) {
        exportedLocals.add(assignment.getExpression().getText());
        exportAliases.add('default');
      }
    }
    for (const assignment of source.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
      if (assignment.getOperatorToken().getKind() !== SyntaxKind.EqualsToken
        || assignment.getLeft().getText() !== 'module.exports') continue;
      const right = assignment.getRight();
      if (Node.isIdentifier(right) && locals.has(right.getText())) exportAliases.add('default');
      if (Node.isObjectLiteralExpression(right)) {
        for (const property of right.getProperties()) {
          if (Node.isShorthandPropertyAssignment(property) && locals.has(property.getName()))
            exportAliases.add(property.getName());
        }
      }
    }
    const clients = new Set([...locals].filter((name) => exportedLocals.has(name)));
    for (const name of exportAliases) clients.add(name);
    if (clients.size) exported.set(source.getFilePath(), clients);
  }
  for (let pass = 0; pass < project.getSourceFiles().length; pass++) {
    let changed = false;
    for (const source of project.getSourceFiles()) {
      for (const declaration of source.getExportDeclarations()) {
        const specifier = declaration.getModuleSpecifierValue();
        if (!specifier) continue;
        const dependency = resolveLocalImport(source, specifier);
        const known = dependency ? exported.get(dependency.getFilePath()) : undefined;
        if (!dependency || !known) continue;
        const existing = exported.get(source.getFilePath());
        const names = existing ? new Set(existing) : new Set<string>();
        const elements = declaration.getNamedExports();
        if (elements.length) {
          for (const element of elements) {
            const original = element.getNameNode().getText();
            if (known.has(original)) names.add(element.getAliasNode()?.getText() ?? element.getName());
          }
        } else if (/^\s*export\s+\*\s+as\b/.test(declaration.getText())) {
          // Namespace re-exports need qualified receiver analysis, which is not yet certain.
          continue;
        } else if (elements.length === 0) {
          for (const name of known) names.add(name);
        }
        if (names.size && (!existing || [...names].some((name) => !existing.has(name)))) {
          exported.set(source.getFilePath(), names);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return exported;
}

function resolveLocalImport(file: SourceFile, specifier: string): SourceFile | undefined {
  const resolved = file.getImportDeclarations().find((declaration) =>
    declaration.getModuleSpecifierValue() === specifier)?.getModuleSpecifierSourceFile();
  if (resolved) return resolved;
  if (!specifier.startsWith('.')) return undefined;
  const base = resolve(file.getDirectoryPath(), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`,
    resolve(base, 'index.ts'), resolve(base, 'index.tsx'), resolve(base, 'index.js'), resolve(base, 'index.jsx')]) {
    const source = file.getProject().getSourceFile(candidate);
    if (source) return source;
  }
  return undefined;
}

interface ModuleOrigin { source?: SourceFile; uncertain: boolean }

function moduleOrigin(expression: Node, visited = new Set<MorphSymbol>()): ModuleOrigin | undefined {
  const node = unwrapTransparentExpression(expression);
  const file = node.getSourceFile();
  if (Node.isCallExpression(node)) {
    const callee = node.getExpression();
    if (callee.getText() === 'require' || callee.getKind() === SyntaxKind.ImportKeyword) {
      const specifier = moduleSpecifierLiteral(node.getArguments()[0]);
      if (!specifier || !(specifier.startsWith('.') || specifier.startsWith('@/') || specifier.startsWith('#'))) return undefined;
      const source = resolveLocalImport(file, specifier);
      return { source, uncertain: !source };
    }
  }
  if (Node.isPropertyAccessExpression(node)) return moduleOrigin(node.getExpression(), visited);
  if (!Node.isIdentifier(node)) return undefined;
  const symbol = node.getSymbol();
  if (!symbol || visited.has(symbol)) return undefined;
  visited.add(symbol);
  for (const declaration of symbol.getDeclarations()) {
    if (Node.isNamespaceImport(declaration)) {
      const specifier = declaration.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)?.getModuleSpecifierValue();
      if (!specifier || !(specifier.startsWith('.') || specifier.startsWith('@/') || specifier.startsWith('#'))) continue;
      const source = resolveLocalImport(file, specifier);
      return { source, uncertain: !source };
    }
    if (Node.isVariableDeclaration(declaration) && declaration.getInitializer()) {
      const origin = moduleOrigin(declaration.getInitializer()!, visited);
      if (origin) return origin;
    }
    if (Node.isParameterDeclaration(declaration)) {
      const callback = declaration.getParent();
      const thenCall = callback?.getParent();
      const thenExpression = thenCall && Node.isCallExpression(thenCall) ? thenCall.getExpression() : undefined;
      if (thenExpression && Node.isPropertyAccessExpression(thenExpression) && thenExpression.getName() === 'then') {
        const origin = moduleOrigin(thenExpression.getExpression(), visited);
        if (origin) return origin;
      }
    }
  }
  return undefined;
}

function globallyEscapedReceivers(project: Project, exportedClients: Map<string, Set<string>>): {
  modules: Set<string>; classFields: Set<MorphSymbol>; classOwners: Map<Node, Set<string>>;
  uncertainFieldNames: Set<string>;
} {
  const modules = new Set<string>();
  const classFields = new Set<MorphSymbol>();
  const classOwners = new Map<Node, Set<string>>();
  const uncertainFieldNames = new Set<string>();
  const namedClasses = new Map<string, Node[]>();
  for (const source of project.getSourceFiles()) for (const declaration of [
    ...source.getDescendantsOfKind(SyntaxKind.ClassDeclaration), ...source.getDescendantsOfKind(SyntaxKind.ClassExpression),
  ]) {
    const name = declaration.getName();
    if (name) namedClasses.set(name, [...(namedClasses.get(name) ?? []), declaration]);
  }
  const markClassHierarchy = (owner: Node, field: string, visited = new Set<Node>()): void => {
    if (visited.has(owner)) return;
    visited.add(owner);
    const fields = classOwners.get(owner) ?? new Set<string>();
    fields.add(field);
    classOwners.set(owner, fields);
    if (!Node.isClassDeclaration(owner) && !Node.isClassExpression(owner)) return;
    const base = owner.getExtends();
    if (!base) return;
    const baseExpression = base.getExpression();
    const declaration = baseExpression.getSymbol()?.getAliasedSymbol()?.getDeclarations().find((node) =>
      Node.isClassDeclaration(node) || Node.isClassExpression(node))
      ?? baseExpression.getSymbol()?.getDeclarations().find((node) =>
        Node.isClassDeclaration(node) || Node.isClassExpression(node));
    const candidates = declaration ? [declaration] : namedClasses.get(baseExpression.getText()) ?? [];
    if (candidates.length === 1) markClassHierarchy(candidates[0]!, field, visited);
    else uncertainFieldNames.add(field);
  };
  const taint = (node: Node): void => {
    const origin = moduleOrigin(node);
    if (origin) {
      if (origin.source) modules.add(origin.source.getFilePath());
      else if (origin.uncertain) for (const file of exportedClients.keys()) modules.add(file);
    }
    const target = unwrapTransparentExpression(node);
    for (const access of [target, ...target.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)]) {
      if (!Node.isPropertyAccessExpression(access) || access.getExpression().getKind() !== SyntaxKind.ThisKeyword) continue;
      const owner = access.getFirstAncestor((ancestor) => Node.isClassDeclaration(ancestor) || Node.isClassExpression(ancestor));
      if (!owner) continue;
      const symbol = access.getNameNode().getSymbol();
      if (symbol) classFields.add(canonicalClientSymbol(symbol));
      markClassHierarchy(owner, access.getName());
    }
  };
  for (const file of project.getSourceFiles()) {
    for (const assignment of file.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
      if (assignment.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue;
      taint(assignment.getLeft());
    }
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const name = call.getExpression().getText();
      if (!['Object.assign', 'Reflect.set', 'Object.defineProperty', 'Reflect.defineProperty'].includes(name)) continue;
      const target = call.getArguments()[0];
      if (target) taint(target);
    }
  }
  // A barrel can expose the same mutable module object under another path.
  for (let pass = 0; pass < project.getSourceFiles().length; pass++) {
    let changed = false;
    for (const file of project.getSourceFiles()) {
      if (modules.has(file.getFilePath())) continue;
      if (file.getExportDeclarations().some((declaration) => {
        const specifier = declaration.getModuleSpecifierValue();
        return Boolean(specifier && resolveLocalImport(file, specifier)
          && modules.has(resolveLocalImport(file, specifier)!.getFilePath()));
      })) { modules.add(file.getFilePath()); changed = true; }
    }
    if (!changed) break;
  }
  return { modules, classFields, classOwners, uncertainFieldNames };
}

function isStablePathArgument(node: Node): boolean {
  if (Node.isNonNullExpression(node)) return Node.isIdentifier(node.getExpression());
  // The SDK's Run.id is a plain response field. Restrict this exception to a
  // simple identifier receiver and the literal `id` property; computed access
  // and arbitrary property expressions remain manual.
  if (Node.isPropertyAccessExpression(node) && node.getName() === 'id' && Node.isIdentifier(node.getExpression())) return true;
  return Node.isIdentifier(node) || Node.isStringLiteral(node) || Node.isNumericLiteral(node)
    || node.getKind() === SyntaxKind.TrueKeyword || node.getKind() === SyntaxKind.FalseKeyword
    || node.getKind() === SyntaxKind.NullKeyword;
}

function transformFile(file: SourceFile, result: MigrationResult, exportedClients: Map<string, Set<string>>,
  referencesBySymbol: Map<MorphSymbol, Node[]>, globalEscapes: ReturnType<typeof globallyEscapedReceivers>): void {
  const imported = new Set<string>();
  const maybeClientImports: MorphSymbol[] = [];
  const globallyTaintedImports = new Set<MorphSymbol>();
  const requiredClientNames = new Set<string>();
  const messageNamespaceImports = new Set<MorphSymbol>();
  const edits: Edit[] = [];
  const typedSource = /\.[cm]?tsx?$/.test(file.getFilePath());
  for (const declaration of file.getImportDeclarations()) {
    if (declaration.getModuleSpecifierValue() === 'openai') {
      if (declaration.getNamespaceImport()) addManual(result, file, declaration, 'OpenAI namespace imports require manual review because receiver bindings cannot be proven safe.');
      const name = declaration.getDefaultImport()?.getText();
      if (name) imported.add(name);
      for (const named of declaration.getNamedImports()) {
        if (named.getName() === 'OpenAI' || named.getName() === 'AzureOpenAI')
          imported.add(named.getAliasNode()?.getText() ?? named.getName());
      }
    }
    if (isLocalOpenAiAlias(declaration.getModuleSpecifierValue())) {
      for (const named of declaration.getNamedImports()) {
        const symbol = (named.getAliasNode() ?? named.getNameNode()).getSymbol();
        if (symbol) maybeClientImports.push(symbol);
      }
    }
  }
  for (const variable of file.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const initializer = variable.getInitializer();
    if (!initializer || !Node.isCallExpression(initializer) || initializer.getExpression().getText() !== 'require') continue;
    const specifier = moduleSpecifierLiteral(initializer.getArguments()[0]);
    const source = specifier ? resolveLocalImport(file, specifier) : undefined;
    const known = source ? exportedClients.get(source.getFilePath()) : undefined;
    if (!known) continue;
    const name = variable.getNameNode();
    if (Node.isObjectBindingPattern(name)) {
      for (const element of name.getElements()) {
        const exportedName = element.getPropertyNameNode()?.getText() ?? element.getName();
        const symbol = element.getNameNode().getSymbol();
        if (known.has(exportedName)) {
          requiredClientNames.add(element.getName());
          if (symbol) maybeClientImports.push(symbol);
        }
      }
    } else if (Node.isIdentifier(name) && known.has('default')) {
      const symbol = name.getSymbol();
      requiredClientNames.add(name.getText());
      if (symbol) maybeClientImports.push(symbol);
    }
  }
  for (const declaration of file.getDescendantsOfKind(SyntaxKind.ImportEqualsDeclaration)) {
    const moduleReference = declaration.getModuleReference();
    if (!Node.isExternalModuleReference(moduleReference)) continue;
    const expression = moduleReference.getExpression();
    if (!expression || !Node.isStringLiteral(expression)) continue;
    const specifier = expression.getLiteralValue();
    if (!isOpenAiSpecifier(specifier)) continue;
    imported.add(declaration.getNameNode().getText());
    addManual(result, file, declaration, 'CommonJS import-equals bindings for OpenAI need a deliberate v5 module interop review.');
  }
  for (const declaration of file.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const initializer = declaration.getInitializer();
    if (initializer && Node.isCallExpression(initializer) && initializer.getExpression().getText() === 'require'
      && isOpenAiSpecifier(moduleSpecifierLiteral(initializer.getArguments()[0]) ?? '')) {
      if (Node.isIdentifier(declaration.getNameNode())) imported.add(declaration.getName());
      else addManual(result, file, declaration, 'Destructured require of openai needs manual binding review.');
    }
  }
  if (file.getProject().getProgram().getSyntacticDiagnostics(file).some((item) => item.getCategory() === 1)) {
    result.manual.push({ file: file.getFilePath(), line: 1, reason: 'The source contains syntax errors; no OpenAI edits were applied.', snippet: '' });
    return;
  }
  const hasOpenAiModuleEvidence = hasOpenAiSpecifierEvidence(file);
  for (const declaration of file.getExportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue();
    if (!specifier) continue;
    const local = specifier.startsWith('.') || specifier.startsWith('@/') || specifier.startsWith('#');
    if (local && !resolveLocalImport(file, specifier))
      addManual(result, file, declaration, 'This local OpenAI client re-export could not be resolved with certainty; review this barrel and its consumers manually.');
    else if (/^\s*export\s+\*\s+as\b/.test(declaration.getText()))
      addManual(result, file, declaration, 'Namespace re-exports cannot be followed with certainty for OpenAI client ownership; review this barrel manually.');
  }
  // v5 removes this helper. It may be imported, re-exported, destructured from
  // require(), or accessed through a namespace/computed property. Never move
  // the module path while a reference remains: the new module has no export.
  const removedUploadHelperCandidate = file.getDescendants().find((node) =>
    (Node.isIdentifier(node) || Node.isStringLiteral(node)) &&
    (Node.isStringLiteral(node) ? node.getLiteralText() : node.getText()) === 'fileFromPath');
  const removedUploadHelper = hasOpenAiSpecifierEvidence(file) ? removedUploadHelperCandidate : undefined;
  if (removedUploadHelper) {
    addManual(result, file, removedUploadHelper,
      'OpenAI v5 removed fileFromPath; choose a supported upload helper manually.');
  }
  const clients = new Set<MorphSymbol>();
  const complexClients = new Set<MorphSymbol>();
  for (const symbol of maybeClientImports) complexClients.add(symbol);
  const narrowedClientScopes = new Map<MorphSymbol, Node>();
  const clientPrefixes = new Map<MorphSymbol, string[]>();
  const variableInitializers = new Map<MorphSymbol, Node>();
  for (const variable of file.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const symbol = variable.getNameNode().getSymbol();
    const initializer = variable.getInitializer();
    if (symbol && initializer) variableInitializers.set(symbol, initializer);
  }
  const apiErrorNames = new Set(file.getImportDeclarations()
    .filter((declaration) => declaration.getModuleSpecifierValue() === 'openai')
    .flatMap((declaration) => declaration.getNamedImports()
      .filter((entry) => entry.getName() === 'APIError')
      .map((entry) => entry.getAliasNode()?.getText() ?? 'APIError')));
  for (const declaration of file.getImportDeclarations()) {
    const source = resolveLocalImport(file, declaration.getModuleSpecifierValue());
    if (!source) {
      const specifier = declaration.getModuleSpecifierValue();
      if (specifier.startsWith('.') || specifier.startsWith('@/') || specifier.startsWith('#')) {
        for (const named of declaration.getNamedImports()) {
          const symbol = (named.getAliasNode() ?? named.getNameNode()).getSymbol();
          if (symbol) complexClients.add(symbol);
        }
        const defaultImport = declaration.getDefaultImport();
        const symbol = defaultImport?.getSymbol();
        if (symbol) complexClients.add(symbol);
      }
      continue;
    }
    const exportedNames = exportedClients.get(source.getFilePath());
    if (globalEscapes.modules.has(source.getFilePath())) {
      const defaultSymbol = declaration.getDefaultImport()?.getSymbol();
      if (defaultSymbol) globallyTaintedImports.add(defaultSymbol);
      for (const named of declaration.getNamedImports()) {
        const symbol = (named.getAliasNode() ?? named.getNameNode()).getSymbol();
        if (symbol) globallyTaintedImports.add(symbol);
      }
    }
    const commonJsExport = source.getDescendantsOfKind(SyntaxKind.BinaryExpression).some((assignment) =>
      assignment.getOperatorToken().getKind() === SyntaxKind.EqualsToken
      && assignment.getLeft().getText() === 'module.exports');
    const defaultImport = declaration.getDefaultImport();
    if (defaultImport?.getSymbol() && exportedNames?.has('default')) {
      (commonJsExport ? complexClients : clients).add(defaultImport.getSymbol()!);
    }
    for (const named of declaration.getNamedImports()) {
      const symbol = (named.getAliasNode() ?? named.getNameNode()).getSymbol();
      if (!symbol) continue;
      if (exportedNames?.has(named.getName())) {
        (commonJsExport ? complexClients : clients).add(symbol);
        continue;
      }
      const uncertainReexport = source.getExportDeclarations().some((exported) => {
        if (!exported.getModuleSpecifierValue()) return false;
        const reexportSource = resolveLocalImport(source, exported.getModuleSpecifierValue()!);
        if (reexportSource) return false;
        return exported.getNamedExports().length === 0
          || exported.getNamedExports().some((entry) => (entry.getAliasNode()?.getText() ?? entry.getName()) === named.getName());
      });
      if (uncertainReexport) complexClients.add(symbol);
    }
  }
  const classFields = new Map<Node, Set<string>>();
  const clientFactorySymbols = new Set<MorphSymbol>();
  const isClientType = (type: Node | undefined): boolean => {
    if (!type) return false;
    const knownClientType = (candidate: Node, visited = new Set<Node>()): boolean => {
      if (visited.has(candidate)) return false;
      visited.add(candidate);
      if (Node.isParenthesizedTypeNode(candidate)) return knownClientType(candidate.getTypeNode(), visited);
      if (Node.isUnionTypeNode(candidate)) return candidate.getTypeNodes().every((part) =>
        (Node.isLiteralTypeNode(part) && [SyntaxKind.NullKeyword, SyntaxKind.UndefinedKeyword].includes(part.getLiteral().getKind()))
        || part.getKind() === SyntaxKind.UndefinedKeyword || part.getKind() === SyntaxKind.NullKeyword
        || knownClientType(part, visited));
      if (!Node.isTypeReference(candidate)) return false;
      const typeName = candidate.getTypeName().getText();
      if ([...imported].some((name) => typeName === name)) return true;
      const symbol = candidate.getTypeName().getSymbol();
      // A named alias may hide a union or conditional client shape. Keep it in
      // the manual-review set instead of treating it as a certain SDK client.
      return Boolean(symbol?.getDeclarations().some((declaration) => {
        if (Node.isInterfaceDeclaration(declaration) && [...imported].includes(declaration.getName())) return true;
        if (Node.isTypeAliasDeclaration(declaration)) {
          const typeNode = declaration.getTypeNode();
          return Boolean(typeNode && knownClientType(typeNode, visited));
        }
        return false;
      }));
    };
    return knownClientType(type);
  };
  const mentionsOpenAiType = (type: Node): boolean => {
    const inspect = (candidate: Node, visited = new Set<string>()): boolean => {
      if ([...imported].some((name) => mentionsIdentifier(candidate.getText(), name))) return true;
      return candidate.getDescendantsOfKind(SyntaxKind.Identifier).some((identifier) => {
        const aliasName = identifier.getText();
        if (visited.has(aliasName)) return false;
        visited.add(aliasName);
        const declaration = identifier.getSymbol()?.getDeclarations().find(Node.isTypeAliasDeclaration)
          ?? file.getTypeAliases().find((alias) => alias.getName() === aliasName);
        const aliasType = declaration && Node.isTypeAliasDeclaration(declaration) ? declaration.getTypeNode() : undefined;
        return Boolean(aliasType && inspect(aliasType, visited));
      });
    };
    return inspect(type);
  };
  const isRunsSubresourceType = (type: Node | undefined): boolean => Boolean(type
    && [...imported].some((name) => new RegExp(`(?:^|[|&()<>,\\s])${escapeRegExp(name)}\\.Beta\\.Threads\\.Runs(?:$|[|&)>?,\\s])`)
      .test(`${type.getText()} ${type.getType().getText()}`)));
  // Trace the repository's explicit OpenAI observation factory shape without
  // trusting arbitrary calls that happen to return a similarly named value.
  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (call.getExpression().getText() !== 'observeOpenAI') continue;
    const argument = call.getArguments()[0];
    if (!argument || !Node.isNewExpression(argument) || !imported.has(argument.getExpression().getText())) continue;
    const owner = call.getFirstAncestor((ancestor) => Node.isArrowFunction(ancestor)
      || Node.isFunctionDeclaration(ancestor) || Node.isFunctionExpression(ancestor));
    if (!owner) continue;
    if (Node.isFunctionDeclaration(owner)) {
      const symbol = owner.getNameNode()?.getSymbol();
      if (symbol) clientFactorySymbols.add(symbol);
    } else {
      const declaration = owner.getParentIfKind(SyntaxKind.VariableDeclaration);
      const symbol = declaration?.getNameNode().getSymbol();
      if (symbol) clientFactorySymbols.add(symbol);
    }
  }
  const rememberField = (node: Node, name: string): void => {
    const owner = node.getFirstAncestor((ancestor) => Node.isClassDeclaration(ancestor) || Node.isClassExpression(ancestor));
    if (!owner) return;
    const fields = classFields.get(owner) ?? new Set<string>();
    fields.add(name);
    classFields.set(owner, fields);
  };
  const isClassThisBinding = (node: Node): boolean => {
    const isClassOwner = (owner: Node | undefined): boolean => Boolean(owner
      && (Node.isClassDeclaration(owner) || Node.isClassExpression(owner)));
    for (let ancestor = node.getParent(); ancestor; ancestor = ancestor.getParent()) {
      if (Node.isArrowFunction(ancestor)) continue;
      if (Node.isFunctionDeclaration(ancestor) || Node.isFunctionExpression(ancestor)) return false;
      if (Node.isMethodDeclaration(ancestor) || Node.isConstructorDeclaration(ancestor)
        || Node.isGetAccessorDeclaration(ancestor) || Node.isSetAccessorDeclaration(ancestor)
        || Node.isPropertyDeclaration(ancestor)) return isClassOwner(ancestor.getParent());
    }
    return false;
  };
  for (const parameter of file.getDescendantsOfKind(SyntaxKind.Parameter)) {
    const type = parameter.getTypeNode();
    if (isClientType(type)) {
      if (Node.isIdentifier(parameter.getNameNode())) {
        const symbol = parameter.getNameNode().getSymbol();
        if (symbol) {
          clients.add(symbol);
          if (isRunsSubresourceType(type)) clientPrefixes.set(symbol, ['beta', 'threads', 'runs']);
        }
        if (parameter.getFirstAncestorByKind(SyntaxKind.Constructor) && parameter.getModifiers().length > 0)
          rememberField(parameter, parameter.getName());
      } else addManual(result, file, parameter, 'valeur OpenAI non suivie : déstructuration d’un paramètre client à revoir manuellement.');
    } else if (type && mentionsOpenAiType(type)) {
      const symbol = parameter.getNameNode().getSymbol();
      if (symbol) complexClients.add(symbol);
    }
  }
  for (const property of file.getDescendantsOfKind(SyntaxKind.PropertyDeclaration)) {
    const type = property.getTypeNode();
    const initializer = property.getInitializer();
    if (isClientType(type)) rememberField(property, property.getName());
    else if (typedSource && Node.isIdentifier(property.getNameNode()) && initializer && Node.isNewExpression(initializer)
      && imported.has(initializer.getExpression().getText()))
      rememberField(property, property.getName());
    else if (type && mentionsOpenAiType(type)) {
      // Keep the field untracked; only an affected use below needs review.
    }
  }
  for (const variable of file.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    let initializer = variable.getInitializer();
    if (initializer?.getKind() === SyntaxKind.AwaitExpression && Node.isAwaitExpression(initializer))
      initializer = initializer.getExpression();
    if (initializer && Node.isCallExpression(initializer) && Node.isIdentifier(initializer.getExpression())) {
      const factory = initializer.getExpression().getSymbol();
      const symbol = variable.getNameNode().getSymbol();
      if (factory && clientFactorySymbols.has(factory) && symbol) clients.add(symbol);
    }
    if (initializer && Node.isNewExpression(initializer) && imported.has(initializer.getExpression().getText())) {
      const symbol = variable.getNameNode().getSymbol();
      if (symbol) clients.add(symbol);
    }
    // A client may be assigned in branches after its declaration. Its explicit
    // imported OpenAI type still identifies the receiver without guessing from
    // an arbitrary property name.
    if (Node.isIdentifier(variable.getNameNode()) && isClientType(variable.getTypeNode())) {
      const symbol = variable.getNameNode().getSymbol();
      if (symbol) clients.add(symbol);
    }
    if (Node.isIdentifier(variable.getNameNode()) && variable.getTypeNode()
      && mentionsOpenAiType(variable.getTypeNode()!)) {
      const symbol = variable.getNameNode().getSymbol();
      if (symbol) complexClients.add(symbol);
    }
    if (Node.isIdentifier(variable.getNameNode()) && isRunsSubresourceType(variable.getTypeNode())) {
      const symbol = variable.getNameNode().getSymbol();
      if (symbol) {
        clients.add(symbol);
        clientPrefixes.set(symbol, ['beta', 'threads', 'runs']);
      }
    }
  }
  // Follow explicit ClientOptions | OpenAI values only in the true branch of
  // an instanceof check. The else branch remains deliberately untracked.
  for (const statement of file.getDescendantsOfKind(SyntaxKind.IfStatement)) {
    const condition = statement.getExpression();
    if (!Node.isBinaryExpression(condition) || condition.getOperatorToken().getKind() !== SyntaxKind.InstanceOfKeyword) continue;
    const left = condition.getLeft();
    const right = condition.getRight();
    const symbol = Node.isIdentifier(left) ? left.getSymbol() : undefined;
    if (!symbol || !complexClients.has(symbol) || !Node.isIdentifier(right) || !imported.has(right.getText())) continue;
    narrowedClientScopes.set(symbol, statement.getThenStatement());
  }
  const assignments = new Map<MorphSymbol, Node[]>();
  const escapedClients = new Set<MorphSymbol>();
  const escapeReasons = new Map<MorphSymbol, string>();
  const escapeCandidates = new Set<MorphSymbol>();
  const escapedClassFields = new Map<Node, Set<string>>();
  const markAssignmentTarget = (target: Node): void => {
    const expression = unwrapTransparentExpression(target);
    if (Node.isIdentifier(expression)) {
      const symbol = expression.getSymbol();
      if (symbol) escapeCandidates.add(symbol);
      return;
    }
    if (Node.isArrayLiteralExpression(expression) || Node.isArrayBindingPattern(expression)) {
      for (const element of expression.getElements()) {
        if (Node.isOmittedExpression(element)) continue;
        markAssignmentTarget(Node.isSpreadElement(element) ? element.getExpression() : Node.isBindingElement(element) ? element.getNameNode() : element);
      }
      return;
    }
    if (Node.isObjectLiteralExpression(expression)) {
      for (const property of expression.getProperties()) {
        if (Node.isShorthandPropertyAssignment(property)) {
          const valueSymbol = file.getProject().getTypeChecker().getShorthandAssignmentValueSymbol(property);
          if (valueSymbol) escapeCandidates.add(valueSymbol);
          markAssignmentTarget(property.getNameNode());
        }
        else if (Node.isPropertyAssignment(property)) {
          const initializer = property.getInitializer();
          if (initializer) markAssignmentTarget(initializer);
        }
        else if (Node.isSpreadAssignment(property)) markAssignmentTarget(property.getExpression());
      }
      return;
    }
    if (Node.isObjectBindingPattern(expression)) {
      for (const element of expression.getElements()) markAssignmentTarget(element.getNameNode());
    }
  };
  for (const assignment of file.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    const left = unwrapTransparentExpression(assignment.getLeft());
    if (Node.isIdentifier(left) && assignment.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
      const symbol = left.getSymbol();
      if (symbol) {
        const values = assignments.get(symbol) ?? [];
        values.push(assignment.getRight());
        assignments.set(symbol, values);
      }
    } else {
      const targetParts = pathParts(left);
      const targetSymbol = rootIdentifier(left)?.getSymbol();
      const harmlessUnchangedMethodStub = assignment.getOperatorToken().getKind() === SyntaxKind.EqualsToken
        && Boolean(targetSymbol && (clients.has(targetSymbol) || complexClients.has(targetSymbol)))
        && ((targetParts.length === 2 && CLIENT_CONFIG_KEYS.has(targetParts[1]!))
          || (targetParts.length >= 3 && !isAffectedWritePath(targetParts.slice(1).join('.'))));
      if (!harmlessUnchangedMethodStub) markAssignmentTarget(left);
      if (assignment.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
        const assignmentParts = pathParts(left);
        const owner = left.getFirstAncestor((ancestor) => Node.isClassDeclaration(ancestor) || Node.isClassExpression(ancestor));
        if (assignmentParts[0] === 'this' && assignmentParts.length >= 2 && owner
          && classFields.get(owner)?.has(assignmentParts[1]!)) {
          const fields = escapedClassFields.get(owner) ?? new Set<string>();
          fields.add(assignmentParts[1]!);
          escapedClassFields.set(owner, fields);
        }
        const root = rootIdentifier(left);
        const symbol = root?.getSymbol();
        const parts = pathParts(left);
        if (!harmlessUnchangedMethodStub && symbol && (clients.has(symbol) || complexClients.has(symbol)) && parts.length > 1)
          escapedClients.add(symbol);
      }
    }
  }
  for (const loop of [...file.getDescendantsOfKind(SyntaxKind.ForOfStatement), ...file.getDescendantsOfKind(SyntaxKind.ForInStatement)]) {
    const initializer = loop.getInitializer();
    markAssignmentTarget(Node.isVariableDeclarationList(initializer)
      ? initializer.getDeclarations()[0]?.getNameNode() ?? initializer
      : initializer);
  }
  // A separately declared alias remains safe when every observed initializer
  // and assignment is itself a tracked client. Iterate to support short alias
  // chains while leaving mixed-source variables untracked.
  for (let pass = 0; pass < file.getDescendantsOfKind(SyntaxKind.VariableDeclaration).length; pass++) {
    let changed = false;
    for (const variable of file.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const initializer = variable.getInitializer();
      const symbol = variable.getNameNode().getSymbol();
      if (!symbol || clients.has(symbol)) continue;
      const values = [...(initializer ? [initializer] : []), ...(assignments.get(symbol) ?? [])];
      if (values.length === 0) continue;
      const hasTrackedSource = values.some((value) => {
        const unwrapped = unwrapTransparentExpression(value);
        if (Node.isIdentifier(unwrapped)) return Boolean(unwrapped.getSymbol() && clients.has(unwrapped.getSymbol()!));
        return Node.isNewExpression(unwrapped) && imported.has(unwrapped.getExpression().getText());
      });
      if (escapedClients.has(symbol)) {
        if (hasTrackedSource) complexClients.add(symbol);
        continue;
      }
      const onlyTrackedClients = values.every((value) => {
        const unwrapped = unwrapTransparentExpression(value);
        if (Node.isIdentifier(unwrapped)) {
          const source = unwrapped.getSymbol();
          return Boolean(source && clients.has(source));
        }
        return Node.isNewExpression(unwrapped) && imported.has(unwrapped.getExpression().getText());
      });
      if (onlyTrackedClients) { clients.add(symbol); changed = true; }
      else if (hasTrackedSource) complexClients.add(symbol);
    }
    if (!changed) break;
  }
  if (globalEscapes.modules.has(file.getFilePath()))
    for (const symbol of [...clients, ...complexClients]) escapedClients.add(symbol);
  for (const symbol of globallyTaintedImports) escapedClients.add(symbol);
  const isAllowedClientReference = (reference: Node): boolean => {
    let current: Node = reference;
    // Type-only references do not pass or expose the runtime client value.
    if (current.getFirstAncestor((ancestor) => Node.isTypeNode(ancestor))) return true;
    let parent = current.getParent();
    while (parent) {
      if ((Node.isParenthesizedExpression(parent) || Node.isNonNullExpression(parent)
        || Node.isAsExpression(parent) || Node.isTypeAssertion(parent) || Node.isSatisfiesExpression(parent))
        && parent.getExpression() === current) {
        current = parent;
        parent = current.getParent();
        continue;
      }
      if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === current) {
        if (['call', 'apply', 'bind'].includes(parent.getName())) return false;
        current = parent;
        parent = current.getParent();
        continue;
      }
      break;
    }
    if (!parent) return false;
    if (Node.isVariableDeclaration(parent) && parent.getNameNode() === current) return true;
    if (Node.isParameterDeclaration(parent) || Node.isImportSpecifier(parent) || Node.isImportClause(parent)) return true;
    if (Node.isExportSpecifier(parent)) {
      const declaration = parent.getFirstAncestorByKind(SyntaxKind.ExportDeclaration);
      const specifier = declaration?.getModuleSpecifierValue();
      return Boolean(declaration && (!specifier || resolveLocalImport(reference.getSourceFile(), specifier)));
    }
    if (Node.isExportAssignment(parent)) return !parent.isExportEquals();
    if (Node.isCallExpression(parent) && parent.getExpression() === current) return true;
    if (Node.isBinaryExpression(parent) && parent.getLeft() === current
      && parent.getOperatorToken().getKind() === SyntaxKind.EqualsToken && Node.isPropertyAccessExpression(current)) {
      const parts = pathParts(current);
      if (parts.length === 2 && CLIENT_CONFIG_KEYS.has(parts[1]!)) return true;
      // Replacing an unrelated leaf method does not change any migrated SDK call.
      if (parts.length >= 3 && !isAffectedWritePath(parts.slice(1).join('.'))) return true;
    }
    return false;
  };
  for (const symbol of new Set([...clients, ...complexClients])) {
    const escapedReference = (referencesBySymbol.get(canonicalClientSymbol(symbol)) ?? []).find((reference) => !isAllowedClientReference(reference));
    if (escapedReference) {
      escapedClients.add(symbol);
      const consumer = escapedReference.getFirstAncestor((ancestor) =>
        (Node.isCallExpression(ancestor) || Node.isNewExpression(ancestor))
        && ancestor.getArguments().some((argument) => argument === escapedReference
          || argument.getDescendants().includes(escapedReference)));
      if (consumer && (Node.isCallExpression(consumer) || Node.isNewExpression(consumer))) {
        const target = `${Node.isNewExpression(consumer) ? 'new ' : ''}${consumer.getExpression().getText()}`;
        escapeReasons.set(symbol, `The OpenAI client is passed to ${target}; verify that ${target} does not modify it before migrating this call.`);
      }
    }
  }
  for (const access of file.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    if (access.getExpression().getKind() !== SyntaxKind.ThisKeyword || !isClassThisBinding(access)) continue;
    const owner = access.getFirstAncestor((ancestor) => Node.isClassDeclaration(ancestor) || Node.isClassExpression(ancestor));
    if (!owner || !classFields.get(owner)?.has(access.getName()) || isAllowedClientReference(access)) continue;
    const fields = escapedClassFields.get(owner) ?? new Set<string>();
    fields.add(access.getName());
    escapedClassFields.set(owner, fields);
  }
  for (const symbol of escapeCandidates) if (clients.has(symbol) || complexClients.has(symbol)) escapedClients.add(symbol);
  for (let pass = 0; pass < file.getDescendantsOfKind(SyntaxKind.VariableDeclaration).length; pass++) {
    let changed = false;
    for (const variable of file.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const symbol = variable.getNameNode().getSymbol();
      const initializer = variable.getInitializer();
      const source = initializer ? rootIdentifier(initializer)?.getSymbol() : undefined;
      if (symbol && source && escapedClients.has(source) && (clients.has(symbol) || complexClients.has(symbol)) && !escapedClients.has(symbol)) {
        escapedClients.add(symbol);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const clientParts = (node: Node): string[] | undefined => {
    const unwrapped = unwrapTransparentExpression(node);
    if (unwrapped !== node) return clientParts(unwrapped);
    if (Node.isIdentifier(node)) {
      const symbol = node.getSymbol();
      if (symbol && escapedClients.has(symbol)) return undefined;
      const scope = symbol ? narrowedClientScopes.get(symbol) : undefined;
      let narrowedHere = false;
      for (let ancestor: Node | undefined = node; scope && ancestor; ancestor = ancestor.getParent()) {
        if (ancestor === scope) { narrowedHere = true; break; }
      }
      return symbol && (clients.has(symbol) || narrowedHere)
      ? clientPrefixes.get(node.getSymbol()!) ?? [] : undefined;
    }
    if (Node.isElementAccessExpression(node)) return undefined;
    if (!Node.isPropertyAccessExpression(node)) return undefined;
    if (node.getExpression().getKind() === SyntaxKind.ThisKeyword) {
      if (!isClassThisBinding(node)) return undefined;
      const owner = node.getFirstAncestor((ancestor) => Node.isClassDeclaration(ancestor) || Node.isClassExpression(ancestor));
      const fieldSymbol = node.getNameNode().getSymbol();
      const globallyEscaped = globalEscapes.uncertainFieldNames.has(node.getName())
        || Boolean(owner && globalEscapes.classOwners.get(owner)?.has(node.getName()))
        || Boolean(fieldSymbol && globalEscapes.classFields.has(canonicalClientSymbol(fieldSymbol)));
      return owner && classFields.get(owner)?.has(node.getName()) && !escapedClassFields.get(owner)?.has(node.getName())
        && !globallyEscaped ? [] : undefined;
    }
    const parent = clientParts(node.getExpression());
    return parent ? [...parent, node.getName()] : undefined;
  };
  const runners = new Set<MorphSymbol>();
  const uncertainRunners = new Set<MorphSymbol>();
  for (const variable of file.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const initializer = variable.getInitializer();
    if (!initializer || !Node.isCallExpression(initializer)) continue;
    const runExpression = initializer.getExpression();
    if (!Node.isPropertyAccessExpression(runExpression)) continue;
    const root = rootIdentifier(runExpression);
    const trackedRunTools = Node.isPropertyAccessExpression(runExpression) && runExpression.getName() === 'runTools'
      && Boolean(clientParts(runExpression));
    const uncertainRunTools = Node.isPropertyAccessExpression(runExpression) && runExpression.getName() === 'runTools'
      && (hasOpenAiModuleEvidence || Boolean(rootIdentifier(runExpression)?.getSymbol()
        && (clients.has(rootIdentifier(runExpression)!.getSymbol()!) || complexClients.has(rootIdentifier(runExpression)!.getSymbol()!))))
      && /(?:^|\.)(?:beta\.)?chat\.completions\.runTools$/.test(pathParts(runExpression).join('.'));
    if (trackedRunTools || uncertainRunTools) {
      const symbol = variable.getNameNode().getSymbol();
      if (symbol) {
        runners.add(symbol);
        if (!trackedRunTools) uncertainRunners.add(symbol);
      }
    }
  }
  const isTrackedRunner = (node: Node): boolean => {
    const unwrapped = unwrapTransparentExpression(node);
    if (Node.isCallExpression(unwrapped)) {
      const chainedCallee = unwrapped.getExpression();
      if (Node.isPropertyAccessExpression(chainedCallee) && chainedCallee.getName() === 'on')
        return isTrackedRunner(chainedCallee.getExpression());
    }
    if (Node.isIdentifier(unwrapped)) {
      const symbol = unwrapped.getSymbol();
      return Boolean(symbol && runners.has(symbol));
    }
    if (!Node.isCallExpression(unwrapped)) return false;
    const callee = unwrapped.getExpression();
    return Node.isPropertyAccessExpression(callee) && callee.getName() === 'runTools'
      && Boolean(clientParts(callee));
  };
  for (const assignment of file.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    if (assignment.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue;
    const left = unwrapTransparentExpression(assignment.getLeft());
    if (!Node.isPropertyAccessExpression(left) || ![...RUN_TOOLS_METHODS.values()].includes(left.getName())
      || !isTrackedRunner(left.getExpression())) continue;
    const symbol = rootIdentifier(left.getExpression())?.getSymbol();
    if (symbol) uncertainRunners.add(symbol);
  }
  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const method = call.getExpression().getText();
    if (!['Object.assign', 'Reflect.set', 'Object.defineProperty', 'Reflect.defineProperty'].includes(method)) continue;
    const target = call.getArguments()[0];
    if (!target || !isTrackedRunner(target)) continue;
    const key = call.getArguments()[1];
    const affected = method === 'Object.assign'
      ? Node.isObjectLiteralExpression(key) && key.getProperties().some((property) =>
        (Node.isPropertyAssignment(property) || Node.isShorthandPropertyAssignment(property))
          && [...RUN_TOOLS_METHODS.values()].includes(property.getName()))
      : Node.isStringLiteral(key) && [...RUN_TOOLS_METHODS.values()].includes(key.getLiteralValue());
    const symbol = affected ? rootIdentifier(target)?.getSymbol() : undefined;
    if (symbol) uncertainRunners.add(symbol);
  }
  const streams = new Set<MorphSymbol>();
  const uncertainStreams = new Set<MorphSymbol>();
  for (const variable of file.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const initializer = variable.getInitializer();
    const symbol = variable.getNameNode().getSymbol();
    if (!initializer || !Node.isCallExpression(initializer) || !symbol) continue;
    const callee = initializer.getExpression();
    if (Node.isPropertyAccessExpression(callee) && callee.getName() === 'stream') {
      const tracked = clientParts(callee)?.join('.') === 'beta.chat.completions.stream';
      const root = rootIdentifier(callee)?.getSymbol();
      const uncertain = (hasOpenAiModuleEvidence || Boolean(root && (clients.has(root) || complexClients.has(root))))
        && /(?:^|\.)beta\.chat\.completions\.stream$/.test(pathParts(callee).join('.'));
      if (tracked || uncertain) streams.add(symbol);
      if (!tracked && uncertain) uncertainStreams.add(symbol);
    }
  }
  const isTrackedStream = (node: Node): boolean => {
    const unwrapped = unwrapTransparentExpression(node);
    return Node.isIdentifier(unwrapped) && Boolean(unwrapped.getSymbol() && streams.has(unwrapped.getSymbol()!));
  };
  for (const constructor of file.getDescendantsOfKind(SyntaxKind.NewExpression)) {
    if (imported.has(constructor.getExpression().getText())) {
      const option = constructor.getArguments()[0];
      const resolved = option && Node.isIdentifier(option) && option.getSymbol()
        ? variableInitializers.get(option.getSymbol()!) : option;
      if (resolved && Node.isObjectLiteralExpression(resolved)) {
        for (const property of resolved.getProperties()) {
          if ((Node.isPropertyAssignment(property) || Node.isShorthandPropertyAssignment(property)) && property.getName() === 'httpAgent')
            addManual(result, file, property, 'httpAgent uses a different transport from fetchOptions in OpenAI v5; review this aliased constructor option manually.');
        }
      }
    }
    const parent = constructor.getParent();
    const assignment = parent && Node.isBinaryExpression(parent)
      && parent.getOperatorToken().getKind() === SyntaxKind.EqualsToken ? parent : undefined;
    const assignedLeft = assignment?.getLeft();
    const assignedKnownClient = assignedLeft && Node.isIdentifier(assignedLeft)
      && Boolean(assignedLeft.getSymbol() && clients.has(assignedLeft.getSymbol()!));
    const assignedOwner = assignment?.getFirstAncestor((ancestor) => Node.isClassDeclaration(ancestor) || Node.isClassExpression(ancestor));
    const assignedKnownClassField = assignedLeft && Node.isPropertyAccessExpression(assignedLeft)
      && assignedLeft.getExpression().getKind() === SyntaxKind.ThisKeyword
      && Boolean(constructor.getFirstAncestorByKind(SyntaxKind.Constructor))
      && Boolean(assignedOwner && classFields.get(assignedOwner)?.has(assignedLeft.getName()));
    const assignedClassField = typedSource && parent && Node.isPropertyDeclaration(parent)
      && Node.isIdentifier(parent.getNameNode()) && parent.getInitializer() === constructor;
    const wrapper = constructor.getParentIfKind(SyntaxKind.CallExpression);
    const wrappedInKnownFactory = wrapper?.getExpression().getText() === 'observeOpenAI'
      && Boolean(wrapper.getFirstAncestor((ancestor) => Node.isArrowFunction(ancestor)
        || Node.isFunctionDeclaration(ancestor) || Node.isFunctionExpression(ancestor)));
    if (imported.has(constructor.getExpression().getText()) && !wrappedInKnownFactory && !Node.isVariableDeclaration(parent)
      && !assignedKnownClient && !assignedKnownClassField && !assignedClassField) {
      addManual(result, file, constructor, 'An OpenAI client stored outside a local variable needs manual receiver review.');
    }
  }
  for (const variable of file.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const initializer = variable.getInitializer();
    if (initializer && Node.isIdentifier(initializer) && initializer.getSymbol() && clients.has(initializer.getSymbol()!)
      && Node.isObjectBindingPattern(variable.getNameNode())) {
      addManual(result, file, variable, 'A destructured OpenAI subclient needs manual review of its v5 methods.');
    }
    if (initializer && Node.isPropertyAccessExpression(initializer)) {
      const root = rootIdentifier(initializer);
      if (root?.getSymbol() && runners.has(root.getSymbol()!) && initializer.getName().startsWith('finalFunctionCall')) {
        addManual(result, file, variable, `OpenAI v5 renames aliased ${initializer.getName()} to ${initializer.getName().replace('FunctionCall', 'FunctionToolCall')}; review the returned value manually.`);
      }
    }
    if (!initializer || !Node.isPropertyAccessExpression(initializer)) continue;
    const root = rootIdentifier(initializer);
    if (root?.getSymbol() && clients.has(root.getSymbol()!) && pathParts(initializer).length >= 2
      && !isRunsSubresourceType(variable.getTypeNode())) {
      addManual(result, file, variable, 'A destructured or aliased OpenAI subclient needs manual review of its v5 methods.');
    }
  }
  for (const declaration of file.getImportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue();
    if (specifier === 'openai/resources/beta/chat/completions') {
      const unknown = declaration.getNamedImports().map((entry) => entry.getName())
        .filter((name) => !V5_BETA_CHAT_COMPLETION_EXPORTS.has(name));
      if (declaration.getNamespaceImport() || unknown.length > 0) {
        const names = declaration.getNamespaceImport() ? 'namespace import' : unknown.join(', ');
        addManual(result, file, declaration, `OpenAI v5 chat completion export(s) could not be confirmed: ${names}; review this import against the v5 declarations.`);
        continue;
      }
    }
    let hasRemovedUploadsExport = false;
    if (specifier === 'openai/uploads') {
      for (const entry of declaration.getNamedImports()) {
        if (REMOVED_UPLOAD_EXPORTS.has(entry.getName())) {
          hasRemovedUploadsExport = true;
          addManual(result, file, entry, `OpenAI v5 removes uploads export ${entry.getName()}; choose a supported replacement manually.`);
        }
      }
    }
    const moved = MOVED_IMPORTS.get(specifier);
    const isMessageModule = specifier === 'openai/resources/beta/threads/messages/messages';
    if (moved && hasDuplicateMovedSpecifier(file, specifier)) {
      addManual(result, file, declaration, `OpenAI v5 moved this module to ${moved}, but the old specifier also appears elsewhere in the file (for example a mock or declaration); update every reference together manually.`);
      continue;
    }
    if (moved && !hasRemovedUploadsExport && !(specifier === 'openai/uploads' && removedUploadHelper)) {
      addEdit(edits, file, declaration.getModuleSpecifier(), `'${moved}'`, 'moved-import');
    }
    if (isMessageModule) {
      const namespaceSymbol = declaration.getNamespaceImport()?.getSymbol();
      if (namespaceSymbol) messageNamespaceImports.add(namespaceSymbol);
      for (const entry of declaration.getNamedImports()) {
        const renamed = MOVED_MESSAGE_TYPES.get(entry.getName());
        if (!renamed) continue;
        const localName = entry.getAliasNode()?.getText() ?? entry.getName();
        const typePrefix = declaration.isTypeOnly() ? '' : 'type ';
        const alias = localName === renamed ? '' : ` as ${localName}`;
        addEdit(edits, file, entry, `${typePrefix}${renamed}${alias}`, 'moved-import');
      }
    } else if (specifier === 'openai/shims' || specifier === 'openai/src' || specifier.startsWith('openai/shims/') || specifier.startsWith('openai/src/'))
      addManual(result, file, declaration, 'OpenAI v5 removes this private or shim import; review the replacement and runtime configuration.');
    if (specifier.startsWith('openai/resources/') && declaration.getNamedImports().some((entry) => /Page$/.test(entry.getName()) && !declaration.isTypeOnly() && !entry.isTypeOnly()))
      addManual(result, file, declaration, 'OpenAI v5 converts resource-specific Page classes to type aliases; review runtime uses before upgrading.');
    if (specifier.startsWith('openai/') && declaration.getNamedImports().some((entry) => entry.getName() === 'APIClient'))
      addManual(result, file, declaration, 'OpenAI v5 removes APIClient; review replacement with the main OpenAI class.');
    if (specifier === 'openai/core')
      addManual(result, file, declaration, 'OpenAI v5 refactors openai/core; review every imported export against the public v5 entry points.');
  }
  for (const qualified of file.getDescendantsOfKind(SyntaxKind.QualifiedName)) {
    const root = rootIdentifier(qualified);
    const name = qualified.getRight().getText();
    const renamed = MOVED_MESSAGE_TYPES.get(name);
    if (renamed && root?.getSymbol() && messageNamespaceImports.has(root.getSymbol()!))
      addEdit(edits, file, qualified.getRight(), renamed, 'moved-import');
  }
  for (const property of file.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    const root = rootIdentifier(property);
    const renamed = MOVED_MESSAGE_TYPES.get(property.getName());
    if (renamed && root?.getSymbol() && messageNamespaceImports.has(root.getSymbol()!))
      addManual(result, file, property, 'A moved OpenAI message type is accessed as a runtime namespace property; review the type-only replacement manually.');
  }
  for (const element of file.getDescendantsOfKind(SyntaxKind.ElementAccessExpression)) {
    const root = rootIdentifier(element);
    const argument = element.getArgumentExpression();
    const name = argument && Node.isStringLiteral(argument) ? argument.getText().slice(1, -1) : undefined;
    if (name && MOVED_MESSAGE_TYPES.has(name) && root?.getSymbol() && messageNamespaceImports.has(root.getSymbol()!))
      addManual(result, file, element, 'A moved OpenAI message type uses computed namespace access; review the v5 type replacement manually.');
  }
  if (file.getFullText().includes('zodResponseFormat')) {
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expression = call.getExpression();
      if (Node.isPropertyAccessExpression(expression) && expression.getName() === 'optional')
        addManual(result, file, call, 'OpenAI v5 rejects optional Zod response fields at runtime; review whether nullable is semantically correct.');
    }
  }
  for (const declaration of file.getExportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue();
    if (specifier === 'openai/resources/beta/chat/completions') {
      const unknown = declaration.getNamedExports().map((entry) => entry.getName())
        .filter((name) => !V5_BETA_CHAT_COMPLETION_EXPORTS.has(name));
      if (declaration.getNamespaceExport() || unknown.length > 0) {
        const names = declaration.getNamespaceExport() ? 'namespace re-export' : unknown.join(', ');
        addManual(result, file, declaration, `OpenAI v5 chat completion export(s) could not be confirmed: ${names}; review this re-export against the v5 declarations.`);
        continue;
      }
    }
    let hasRemovedUploadsExport = false;
    if (specifier === 'openai/uploads') {
      for (const entry of declaration.getNamedExports()) {
        if (REMOVED_UPLOAD_EXPORTS.has(entry.getName())) {
          hasRemovedUploadsExport = true;
          addManual(result, file, entry, `OpenAI v5 removes uploads export ${entry.getName()}; review this public re-export manually.`);
        }
      }
    }
    const moved = specifier ? MOVED_IMPORTS.get(specifier) : undefined;
    if (moved && hasDuplicateMovedSpecifier(file, specifier!)) {
      addManual(result, file, declaration, `OpenAI v5 moved this module to ${moved}, but the old specifier also appears elsewhere in the file; update every reference together manually.`);
      continue;
    }
    if (moved && !hasRemovedUploadsExport && !(specifier === 'openai/uploads' && removedUploadHelper) && declaration.getModuleSpecifier()) {
      addEdit(edits, file, declaration.getModuleSpecifier()!, `'${moved}'`, 'moved-import');
    }
    if (MOVED_IMPORTS.has(specifier ?? '')) {
      for (const entry of declaration.getNamedExports()) {
        const renamed = MOVED_MESSAGE_TYPES.get(entry.getName());
        if (!renamed) continue;
        const typePrefix = declaration.isTypeOnly() ? '' : 'type ';
        const aliasName = entry.getAliasNode()?.getText() ?? entry.getName();
        const alias = aliasName === renamed ? '' : ` as ${aliasName}`;
        addEdit(edits, file, entry, `${typePrefix}${renamed}${alias}`, 'moved-import');
      }
    }
  }
  for (const importType of file.getDescendantsOfKind(SyntaxKind.ImportType)) {
    const argument = importType.getArgument();
    const rawSpecifier = argument.getText();
    if (!/^(['"]).*\1$/.test(rawSpecifier)) continue;
    const specifier = rawSpecifier.slice(1, -1);
    if (specifier === 'openai/resources/beta/chat/completions') {
      const qualifier = importType.getQualifier();
      const leaf = qualifier && Node.isQualifiedName(qualifier) ? qualifier.getRight() : qualifier;
      if (!leaf || !Node.isIdentifier(leaf) || !V5_BETA_CHAT_COMPLETION_EXPORTS.has(leaf.getText())) {
        addManual(result, file, importType, 'OpenAI v5 chat completion type export could not be confirmed from this import type; review it manually.');
        continue;
      }
    }
    const moved = MOVED_IMPORTS.get(specifier);
    if (moved) {
      if (hasDuplicateMovedSpecifier(file, specifier)) {
        addManual(result, file, importType, `OpenAI v5 moved this module to ${moved}, but the old specifier also appears elsewhere in the file; update every reference together manually.`);
        continue;
      }
      const quote = rawSpecifier[0];
      addEdit(edits, file, argument, `${quote}${moved}${quote}`, 'moved-import');
    }
    if (specifier !== 'openai/resources/beta/threads/messages/messages') continue;
    const qualifier = importType.getQualifier();
    const leaf = qualifier && Node.isQualifiedName(qualifier) ? qualifier.getRight() : qualifier;
    if (!leaf || !Node.isIdentifier(leaf)) continue;
    const renamed = MOVED_MESSAGE_TYPES.get(leaf.getText());
    if (renamed) addEdit(edits, file, leaf, renamed, 'moved-import');
  }
  if (hasOpenAiModuleEvidence) {
    for (const identifier of file.getDescendantsOfKind(SyntaxKind.Identifier)) {
      if (REMOVED_RUNNER_TYPES.has(identifier.getText()))
        addManual(result, file, identifier, `OpenAI v5 removes ${identifier.getText()}; review the replacement type manually.`);
    }
    for (const qualified of file.getDescendantsOfKind(SyntaxKind.QualifiedName)) {
      if (Node.isTypeReference(qualified.getParent()!) && /(?:^|\.)Beta\.Chat\.Completions\./.test(qualified.getText()))
        addManual(result, file, qualified, 'OpenAI v5 changes the Beta Chat Completions type namespace; select the v5 public type manually.');
    }
  }
  const apiErrorInstanceScopes = new Map<MorphSymbol, Node[]>();
  for (const statement of file.getDescendantsOfKind(SyntaxKind.IfStatement)) {
    const condition = statement.getExpression();
    if (!Node.isBinaryExpression(condition) || condition.getOperatorToken().getKind() !== SyntaxKind.InstanceOfKeyword
      || !Node.isIdentifier(condition.getLeft())) continue;
    const right = condition.getRight().getText();
    if (![...imported].some((name) => right === `${name}.APIError`) && !apiErrorNames.has(right)) continue;
    const symbol = condition.getLeft().getSymbol();
    if (!symbol) continue;
    const scopes = apiErrorInstanceScopes.get(symbol) ?? [];
    scopes.push(statement.getThenStatement());
    apiErrorInstanceScopes.set(symbol, scopes);
  }
  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expression = call.getExpression();
    const callPath = Node.isPropertyAccessExpression(expression) ? pathParts(expression).join('.') : '';
    const pollMethod = [...VECTOR_STORE_POLLING_METHODS].find((method) => callPath === method || callPath.endsWith(`.${method}`));
    if (pollMethod)
      addManual(result, file, call, 'OpenAI v5 vector store polling helpers have changed signatures; verify both resource identifiers and arguments manually.');
    if (callPath === 'beta.chat.completions.stream' || callPath.endsWith('.beta.chat.completions.stream')) {
      let chained: Node = call;
      let parent = chained.getParent();
      while (parent && (Node.isPropertyAccessExpression(parent) || Node.isCallExpression(parent))) {
        chained = parent;
        parent = chained.getParent();
      }
      const chainText = chained.getText();
      if (/\.on\s*\(\s*['"](?:functionCall|functionCallResult|finalFunctionCall|finalFunctionCallResult)['"]/.test(chainText)
        || /\.finalFunctionCall(?:Result)?\s*\(/.test(chainText))
        addManual(result, file, call, 'OpenAI v5 changes the Beta Chat streaming function-call events and final methods; migrate the stream event handling manually.');
    }
    if (Node.isPropertyAccessExpression(expression) && ['nextPageParams', 'nextPageInfo'].includes(expression.getName()))
      addManual(result, file, call, 'OpenAI v5 pagination uses nextPageRequestOptions; review manual pagination logic.');
    if (Node.isPropertyAccessExpression(expression) && expression.getName() === 'pipe'
      && file.getFullText().includes('.asResponse()') && expression.getExpression().getText().endsWith('.body'))
      addManual(result, file, call, 'OpenAI v5 Web response body is a ReadableStream; use a deliberate Web-to-Node stream conversion.');
    if (expression.getText() === 'require' || expression.getKind() === SyntaxKind.ImportKeyword) {
      const argument = call.getArguments()[0];
      const specifier = argument?.getText().replace(/^['"]|['"]$/g, '');
      const moved = specifier ? MOVED_IMPORTS.get(specifier) : undefined;
      const declaration = call.getParentIfKind(SyntaxKind.VariableDeclaration);
      const binding = declaration?.getNameNode();
      const hasRemovedUploadsExport = specifier === 'openai/uploads' && binding && Node.isObjectBindingPattern(binding)
        && binding.getElements().some((element) => REMOVED_UPLOAD_EXPORTS.has(
          element.getPropertyNameNode()?.getText() ?? element.getNameNode().getText()));
      if (moved && argument && hasDuplicateMovedSpecifier(file, specifier!)) {
        addManual(result, file, call, `OpenAI v5 moved this module to ${moved}, but the old specifier also appears elsewhere in the file; update every reference together manually.`);
      } else if (moved && argument && !hasRemovedUploadsExport && !(specifier === 'openai/uploads' && removedUploadHelper))
        addEdit(edits, file, argument, `'${moved}'`, 'moved-import');
      if (specifier === 'openai/uploads') {
        if (binding && Node.isObjectBindingPattern(binding)) {
          for (const element of binding.getElements()) {
            const name = element.getPropertyNameNode()?.getText() ?? element.getNameNode().getText();
            if (REMOVED_UPLOAD_EXPORTS.has(name))
              addManual(result, file, element, `OpenAI v5 removes uploads export ${name}; review this CommonJS binding manually.`);
          }
        }
      }
    }
    let wrappedTarget: Node | undefined;
    let wrapped = expression;
    while (Node.isCallExpression(wrapped)) {
      const wrappedExpression = wrapped.getExpression();
      if (!Node.isPropertyAccessExpression(wrappedExpression) || !['call', 'apply', 'bind'].includes(wrappedExpression.getName())) break;
      wrapped = wrappedExpression;
    }
    if (Node.isPropertyAccessExpression(wrapped) && ['call', 'apply', 'bind'].includes(wrapped.getName()))
      wrappedTarget = wrapped.getExpression();
    if (wrappedTarget) {
      const targetMethod = clientParts(wrappedTarget)?.join('.') ?? affectedSuffix(partsAfterLastComputedAccess(wrappedTarget));
      const computedTarget = Node.isElementAccessExpression(wrappedTarget)
        || wrappedTarget.getDescendantsOfKind(SyntaxKind.ElementAccessExpression).length > 0;
      const targetRoot = rootIdentifier(wrappedTarget)?.getSymbol();
      if ((targetMethod && (isAffectedMethod(targetMethod) || affectedSuffix(targetMethod.split('.')) !== undefined)) || (computedTarget && Boolean(targetRoot && (clients.has(targetRoot) || complexClients.has(targetRoot))))
        || (computedTarget && rootIdentifier(wrappedTarget)?.getText() === 'openai' && hasOpenAiModuleEvidence))
        addManual(result, file, call, 'OpenAI v5 changes this method, but .call/.apply/.bind obscures its receiver and arguments; review it manually.');
      continue;
    }
    if (Node.isElementAccessExpression(expression)) {
      const possibleMethod = affectedSuffix(partsAfterLastComputedAccess(expression));
      const root = rootIdentifier(expression)?.getSymbol();
      if (Boolean(possibleMethod) || Boolean(root && (clients.has(root) || complexClients.has(root)))
        || (rootIdentifier(expression)?.getText() === 'openai' && hasOpenAiModuleEvidence && partsAfterLastComputedAccess(expression).join('.') === 'chat.completions.create'))
        addManual(result, file, call, 'OpenAI v5 changes this method, but computed receiver access requires manual review.');
      continue;
    }
    if (!Node.isPropertyAccessExpression(expression)) continue;
    const isTrackedOpenAiChain = (candidate: Node): boolean => {
      const value = unwrapTransparentExpression(candidate);
      if (Node.isIdentifier(value)) {
        const symbol = value.getSymbol();
        return Boolean(symbol && (clients.has(symbol) || complexClients.has(symbol)));
      }
      if (Node.isPropertyAccessExpression(value) || Node.isElementAccessExpression(value)) return isTrackedOpenAiChain(value.getExpression());
      if (Node.isCallExpression(value)) return isTrackedOpenAiChain(value.getExpression());
      return false;
    };
    if ((expression.getName() === 'withResponse' || expression.getName() === 'asResponse')
      && isTrackedOpenAiChain(expression.getExpression())) {
      addManual(result, file, call, 'OpenAI v5 Web response helpers return standard Web response types; review Headers and ReadableStream handling.');
    }
    const onRunner = expression.getName() === 'on' && isTrackedRunner(expression.getExpression());
    const runnerSymbol = rootIdentifier(expression.getExpression())?.getSymbol();
    const onUncertainRunner = onRunner && Boolean(runnerSymbol && uncertainRunners.has(runnerSymbol));
    const onStream = expression.getName() === 'on' && isTrackedStream(expression.getExpression());
    if (onRunner && expression.getName() === 'on') {
      const eventNode = call.getArguments()[0];
      const replacement = eventNode && Node.isStringLiteral(eventNode)
        ? RUN_TOOLS_EVENTS.get(eventNode.getLiteralText()) : undefined;
      if (replacement && eventNode && onUncertainRunner) {
        addManual(result, file, call, `OpenAI v5 renames runTools event ${eventNode.getText()} to ${replacement}, but this client's receiver is uncertain; review manually.`);
      } else if (replacement && eventNode) {
        const quote = eventNode.getText().startsWith('"') ? '"' : "'";
        addEdit(edits, file, eventNode, `${quote}${replacement}${quote}`, 'run-tools-event');
      } else if (eventNode && !Node.isStringLiteral(eventNode))
        addManual(result, file, eventNode, 'A runTools event name passed indirectly needs manual review against the v5 event names.');
    }
    if (onStream) {
      const eventNode = call.getArguments()[0];
      const changedEvents = new Set(['functionCall', 'functionCallResult', 'finalFunctionCall', 'finalFunctionCallResult']);
      if (!eventNode || !Node.isStringLiteral(eventNode) || changedEvents.has(eventNode.getLiteralText()))
        addManual(result, file, call, 'OpenAI v5 changes Beta Chat stream event names; review this stream listener against the v5 event API.');
    }
    const parts = clientParts(expression);
    if (!parts || parts.length < 2) {
      const root = rootIdentifier(expression);
      const hasComputedPath = Node.isElementAccessExpression(expression)
        || expression.getDescendantsOfKind(SyntaxKind.ElementAccessExpression).length > 0;
      const rootSymbol = root?.getSymbol();
      const expressionParts = pathParts(expression);
      const receiverPrefix = rootSymbol ? clientPrefixes.get(rootSymbol) : undefined;
      const possibleMethod = (receiverPrefix?.length
        ? affectedSuffix([...receiverPrefix, ...expressionParts.slice(1)]) : undefined)
        ?? affectedSuffix(partsAfterLastComputedAccess(expression)) ?? affectedSuffix(expressionParts);
      if (rootSymbol && escapedClients.has(rootSymbol) && possibleMethod) {
        addManual(result, file, call, escapeReasons.get(rootSymbol)
          ?? (CHANGED_PATH_METHODS.has(possibleMethod) || SAFE_NAMED_PATH_REWRITES.has(possibleMethod)
            ? 'OpenAI v5 uses named path parameters for this method, but its client receiver is not tracked safely because it escapes; review this affected call manually.'
            : 'The OpenAI client receiver is not tracked safely because it escapes; review this affected call manually.'));
        continue;
      }
      if (Node.isIdentifier(root) && requiredClientNames.has(root.getText()) && possibleMethod) {
        addManual(result, file, call,
          'A client imported through local require/module.exports has an uncertain receiver; review this affected call manually.');
        continue;
      }
      const definitelyStructuredOther = Boolean(root?.getSymbol()?.getDeclarations().length
        && root.getSymbol()!.getDeclarations().every((declaration) => {
          const type = Node.isParameterDeclaration(declaration) || Node.isVariableDeclaration(declaration)
            ? declaration.getTypeNode() : undefined;
          return Boolean(type && Node.isTypeLiteral(type) && ![...imported].some((name) => mentionsIdentifier(type.getText(), name)));
        }));
      const trackedRoot = Boolean(rootSymbol && (clients.has(rootSymbol) || complexClients.has(rootSymbol)));
      const evidenceAllowsSuffix = hasOpenAiModuleEvidence && (possibleMethod?.split('.').length ?? 0) >= 3;
      const thisReceiverField = root?.getKind() === SyntaxKind.ThisKeyword ? pathParts(expression)[1] : undefined;
      const classOwner = expression.getFirstAncestor((ancestor) => Node.isClassDeclaration(ancestor) || Node.isClassExpression(ancestor));
      const knownThisClient = Boolean(thisReceiverField && classOwner && classFields.get(classOwner)?.has(thisReceiverField));
      const completePath = pathParts(expression).join('.');
      const completeMethodPath = [...DELETED_METHODS, ...CHANGED_PATH_METHODS, ...SAFE_NAMED_PATH_REWRITES.keys()]
        .some((method) => completePath === method || completePath.endsWith(`.${method}`));
      if ((Boolean(possibleMethod) && ((trackedRoot && !escapedClients.has(rootSymbol!)) || evidenceAllowsSuffix) && !definitelyStructuredOther || (hasComputedPath
        && Boolean(rootSymbol && (clients.has(rootSymbol) || complexClients.has(rootSymbol))))
        || (hasOpenAiModuleEvidence && root?.getKind() !== SyntaxKind.ThisKeyword && completeMethodPath && !definitelyStructuredOther)
        || (Boolean(possibleMethod) && knownThisClient)
        || (hasComputedPath && root?.getText() === 'openai' && hasOpenAiModuleEvidence
          && partsAfterLastComputedAccess(expression).join('.') === 'chat.completions.create')))
        addManual(result, file, call, possibleMethod && (SAFE_NAMED_PATH_REWRITES.has(possibleMethod) || CHANGED_PATH_METHODS.has(possibleMethod))
          ? 'OpenAI v5 uses named path parameters for this method, but its receiver is not tracked safely; review the receiver and arguments manually.'
          : 'OpenAI v5 changes this method, but its client receiver is not tracked safely; review the receiver and arguments manually.');
      if (root?.getSymbol() && complexClients.has(root.getSymbol()!) && possibleMethod)
        addManual(result, file, call, 'The OpenAI receiver is not tracked safely; review this client variant and method manually.');
      continue;
    }
    const root = rootIdentifier(expression);
    const rootSymbol = root?.getSymbol();
    const methodPath = parts.join('.');
    if (rootSymbol && escapedClients.has(rootSymbol)) {
      addManual(result, file, call, escapeReasons.get(rootSymbol)
        ?? 'The OpenAI client escapes through a use the migration cannot prove safe; review this affected call manually.');
      continue;
    }
    const method = parts.join('.');
    const namedPathKey = SAFE_NAMED_PATH_REWRITES.get(method);
    if (namedPathKey) {
      const args = call.getArguments();
      const safeShape = args.length === 2 && args.every(isStablePathArgument)
        && /^,\s*$/.test(file.getFullText().slice(args[0]!.getEnd(), args[1]!.getStart()));
      if (safeShape) {
        const leadingComments = args.flatMap((argument) =>
          [...file.getFullText().slice(argument.getFullStart(), argument.getStart()).matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g)].map(([comment]) => comment));
        const optionalCall = call.getQuestionDotTokenNode()?.getText() ?? '';
        const typeArguments = call.getTypeArguments().map((argument) => argument.getText()).join(', ');
        const typeArgumentText = typeArguments ? `<${typeArguments}>` : '';
        addEdit(edits, file, call,
          `${expression.getText()}${optionalCall}${typeArgumentText}(${leadingComments.length ? `${leadingComments.join(' ')} ` : ''}${args[1]!.getText()}, { ${namedPathKey}: ${args[0]!.getText()} })`,
          'named-path-parameters');
      } else if (method === 'beta.threads.runs.submitToolOutputs' && args.length === 3
        && isStablePathArgument(args[0]!) && isStablePathArgument(args[1]!)
        && Node.isObjectLiteralExpression(args[2]!)
        && !args[2]!.getProperties().some((property) =>
          (Node.isPropertyAssignment(property) || Node.isShorthandPropertyAssignment(property)) && property.getName() === 'thread_id')) {
        addEdit(edits, file, call,
          `${expression.getText()}(${args[1]!.getText()}, { ...(${args[2]!.getText()}), ${namedPathKey}: ${args[0]!.getText()} })`,
          'named-path-parameters');
      } else {
        addManual(result, file, call, 'OpenAI v5 uses named path parameters here; argument count, spread, or expression order is ambiguous.');
      }
      continue;
    }
    if (call.getArguments().some((argument) => Node.isCallExpression(argument)
      && argument.getExpression().getText() === 'encodeURIComponent'))
      addManual(result, file, call, 'OpenAI v5 URI-encodes path parameters itself; remove only deliberate pre-encoding after reviewing the endpoint.');
    if (call.getArguments().some((argument) => Node.isIdentifier(argument)
      && argument.getSymbol() && Node.isCallExpression(variableInitializers.get(argument.getSymbol()!) ?? undefined)
      && (variableInitializers.get(argument.getSymbol()!) as Node).getText().startsWith('encodeURIComponent(')))
      addManual(result, file, call, 'OpenAI v5 URI-encodes path parameters itself; this argument was pre-encoded in a local variable. Review the endpoint.');
    if (REQUEST_OPTION_OVERLOADS.has(method) && call.getArguments().length === 1) {
      const argument = call.getArguments()[0];
      const resolved = argument && Node.isIdentifier(argument) && argument.getSymbol()
        ? variableInitializers.get(argument.getSymbol()!) : argument;
      if (resolved && Node.isObjectLiteralExpression(resolved)
        && resolved.getProperties().some((property) =>
          (Node.isPropertyAssignment(property) || Node.isShorthandPropertyAssignment(property))
          && REQUEST_OPTION_KEYS.has(property.getName())))
        addManual(result, file, call, 'OpenAI v5 removed this request options overload; separate params from request options manually.');
    }
    if (method.endsWith('.runFunctions')) {
      addManual(result, file, call, 'OpenAI v5 removes runFunctions; migrate function definitions and handling to runTools manually.');
    } else if (method === 'beta.threads.runs.poll' || method === 'beta.threads.runs.submitToolOutputsAndPoll') {
      addManual(result, file, call, 'OpenAI v5 changes this run helper; review its replacement and arguments manually.');
    } else if (DELETED_METHODS.has(method) && (call.getArguments().length >= 2 || call.getArguments().some(Node.isSpreadElement))) {
      addManual(result, file, call, 'OpenAI v5 changes path parameters for this delete call; review the argument names and order in the official guide.');
    } else if (CHANGED_PATH_METHODS.has(method) && (call.getArguments().length >= 2 || call.getArguments().some(Node.isSpreadElement))) {
      addManual(result, file, call, 'OpenAI v5 uses named path parameters here; check argument names and order in the official guide.');
    } else if (DELETED_METHODS.has(method)) {
      addEdit(edits, file, expression.getNameNode(), 'delete', 'del-to-delete');
    }
  }
  for (const property of file.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    if (property.getName() === 'headers' && Node.isIdentifier(property.getExpression())) {
      const receiver = property.getExpression();
      const symbol = receiver.getSymbol();
      const inApiErrorScope = Boolean(symbol && apiErrorInstanceScopes.get(symbol)?.some((scope) => {
        for (let ancestor: Node | undefined = property; ancestor; ancestor = ancestor.getParent()) if (ancestor === scope) return true;
        return false;
      }));
      if (inApiErrorScope)
        addManual(result, file, property, 'OpenAI v5 APIError.headers is a Web Headers object, not a string record; use Headers.get() after review.');
    }
    if (property.getName() === 'headers' && apiErrorNames.size > 0 && Node.isIdentifier(property.getExpression())) {
      const receiver = property.getExpression();
      const declaration = receiver.getSymbol()?.getDeclarations()[0];
      const annotated = declaration && (Node.isParameterDeclaration(declaration) || Node.isVariableDeclaration(declaration))
        ? declaration.getTypeNode()?.getText() : undefined;
      if (annotated && [...apiErrorNames].some((name) => annotated.split(/[^A-Za-z0-9_$]+/).includes(name)))
        addManual(result, file, property, 'OpenAI v5 APIError.headers is a Web Headers object, not a string record; use Headers.get() after review.');
    }
    const renamedRunnerMethod = RUN_TOOLS_METHODS.get(property.getName());
    if (renamedRunnerMethod) {
      const tracked = isTrackedRunner(property.getExpression());
      if (tracked) {
        const parent = property.getParent();
        const runnerRoot = rootIdentifier(property.getExpression())?.getSymbol();
        if (runnerRoot && uncertainRunners.has(runnerRoot))
          addManual(result, file, property, `OpenAI v5 renames ${property.getName()} to ${renamedRunnerMethod}, but the runTools receiver is not certain; review manually.`);
        else if (parent && Node.isCallExpression(parent) && parent.getExpression() === property)
          addEdit(edits, file, property.getNameNode(), renamedRunnerMethod, 'run-tools-method');
        else addManual(result, file, property, `OpenAI v5 renames ${property.getName()} to ${renamedRunnerMethod}; review bound or aliased methods manually.`);
      }
    }
    if (property.getName() !== 'chat') continue;
    const parent = property.getParentIfKind(SyntaxKind.PropertyAccessExpression);
    if (!parent || parent.getName() !== 'completions') continue;
    const beta = property.getExpression();
    if (!Node.isPropertyAccessExpression(beta) || beta.getName() !== 'beta') continue;
    if (clientParts(beta.getExpression())?.length === 0)
      addEdit(edits, file, beta, beta.getExpression().getText(), 'beta-chat');
    else addManual(result, file, property, 'OpenAI v5 removes beta.chat, but this client receiver is not tracked safely.');
  }
  for (const variable of file.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    if (!Node.isObjectBindingPattern(variable.getNameNode())) continue;
    const initializer = variable.getInitializer();
    if (!initializer || !Node.isIdentifier(initializer) || !initializer.getSymbol() || !runners.has(initializer.getSymbol()!)) continue;
    if (variable.getNameNode().getText().includes('finalFunctionCall'))
      addManual(result, file, variable, 'OpenAI v5 renames destructured finalFunctionCall to finalFunctionToolCall; review the runner manually.');
  }
  for (const property of file.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    if (property.getName() !== 'httpAgent') continue;
    const parent = property.getParentIfKind(SyntaxKind.ObjectLiteralExpression);
    const constructor = parent?.getParent();
    if (constructor && Node.isNewExpression(constructor) && imported.has(constructor.getExpression().getText()))
      addManual(result, file, property, 'httpAgent uses a different transport from fetchOptions in OpenAI v5; configure it manually.');
  }
  if (edits.length === 0) return;
  const ascending = [...edits].sort((a, b) => a.start - b.start);
  if (ascending.some((item, index) => index > 0 && item.start < ascending[index - 1]!.end)) {
    result.manual.push({ file: file.getFilePath(), line: 1, reason: 'Overlapping OpenAI edits require manual review.', snippet: '' });
    return;
  }
  let contents = file.getFullText();
  for (const item of ascending.reverse()) contents = contents.slice(0, item.start) + item.replacement + contents.slice(item.end);
  result.fileUpdates!.push({ file: file.getFilePath(), contents });
  result.filesChanged.push(file.getFilePath());
  for (const item of edits) result.changes.push({ file: file.getFilePath(), line: item.line,
    rule: item.rule, before: item.before, after: item.replacement } satisfies Change);
}

export const openaiV5: Migration = {
  id: 'openai@5', packageName: 'openai', fromMajor: 4, toMajor: 5,
  experimental: true,
  releasedAt: '2025-05-29', title: 'openai v4 → v5', guideUrl: GUIDE,
  rules: ['del-to-delete', 'beta-chat', 'moved-import'],
  transform(project: Project): MigrationResult {
    const result: MigrationResult = { changes: [], manual: [], filesChanged: [], fileUpdates: [] };
    const exportedClients = directlyConstructedOpenAIExports(project);
    const globalEscapes = globallyEscapedReceivers(project, exportedClients);
    const referencesBySymbol = new Map<MorphSymbol, Node[]>();
    for (const source of project.getSourceFiles()) {
      for (const identifier of source.getDescendantsOfKind(SyntaxKind.Identifier)) {
        const shorthand = identifier.getParent();
        const symbol = Node.isShorthandPropertyAssignment(shorthand) && shorthand.getNameNode() === identifier
          ? project.getTypeChecker().getShorthandAssignmentValueSymbol(shorthand) ?? identifier.getSymbol()
          : identifier.getSymbol();
        if (!symbol) continue;
        const origin = canonicalClientSymbol(symbol);
        const references = referencesBySymbol.get(origin) ?? [];
        references.push(identifier);
        referencesBySymbol.set(origin, references);
      }
    }
    for (const file of project.getSourceFiles()) transformFile(file, result, exportedClients, referencesBySymbol, globalEscapes);
    return result;
  },
  updateManifest(manifest: PackageManifest): string[] {
    const notes: string[] = [];
    const range = manifest.engines?.node;
    if (!range || !guaranteesNodeMajor(range, 20)) {
      return [`OpenAI SDK v5 requires Node.js 20 or later. Declare a compatible engines.node range and confirm the deployed runtime before upgrading; current range: ${range ?? 'not declared'}.`];
    }
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      const old = manifest[section]?.openai;
      if (!old) continue;
      const match = /^\s*[~^]?(\d+)(?:\.(?:\d+|x|\*)){0,2}\s*$/.exec(old);
      if (!match || Number(match[1]) !== 4) {
        notes.push(`Could not safely update ${section}.openai from ${old}; this migration only targets v4.`);
      } else {
        manifest[section]!.openai = '^5.0.0';
        notes.push(`\`${section}.openai\`: \`${old}\` → \`^5.0.0\``);
      }
    }
    return notes;
  },
  inspectManifest(manifest: PackageManifest): string[] {
    const range = manifest.engines?.node;
    return range && guaranteesNodeMajor(range, 20) ? []
      : [`OpenAI SDK v5 requires Node.js 20 or later; review engines.node (${range ?? 'not declared'}) before upgrading.`];
  },
};
