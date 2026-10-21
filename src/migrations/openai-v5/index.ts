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
const MOVED_IMPORTS = new Map([
  ['openai/error', 'openai/core/error'],
  ['openai/pagination', 'openai/core/pagination'],
  ['openai/resource', 'openai/core/resource'],
  ['openai/streaming', 'openai/core/streaming'],
  ['openai/uploads', 'openai/core/uploads'],
  ['openai/resources/beta/chat/completions', 'openai/resources/chat/completions'],
  ['openai/resources/beta/threads/messages/messages', 'openai/resources/beta/threads/messages'],
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
  if (Node.isPropertyAccessExpression(node)) return [...pathParts(node.getExpression()), node.getName()];
  if (Node.isElementAccessExpression(node)) {
    const argument = node.getArgumentExpression();
    if (argument && Node.isStringLiteral(argument))
      return [...pathParts(node.getExpression()), argument.getText().slice(1, -1)];
  }
  return [];
}

function rootIdentifier(node: Node): Node | undefined {
  const expression = unwrapTransparentExpression(node);
  if (expression !== node) return rootIdentifier(expression);
  if (Node.isIdentifier(node)) return node;
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

function isAffectedMethod(method: string): boolean {
  return DELETED_METHODS.has(method) || CHANGED_PATH_METHODS.has(method) || SAFE_NAMED_PATH_REWRITES.has(method);
}

function addManual(result: MigrationResult, file: SourceFile, node: Node, reason: string): void {
  result.manual.push({ file: file.getFilePath(), line: file.getLineAndColumnAtPos(node.getStart()).line,
    reason, snippet: node.getText().slice(0, 500) });
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
    for (const variable of source.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      if (!Node.isIdentifier(variable.getNameNode())) continue;
      const statement = variable.getParentIfKind(SyntaxKind.VariableDeclarationList)
        ?.getParentIfKind(SyntaxKind.VariableStatement);
      if (!statement?.getModifiers().some((modifier) => modifier.getKind() === SyntaxKind.ExportKeyword)) continue;
      const initializer = variable.getInitializer();
      if (!initializer || !Node.isNewExpression(initializer) || !Node.isIdentifier(initializer.getExpression())
        || !constructors.has(initializer.getExpression().getText())) continue;
      const names = exported.get(source.getFilePath()) ?? new Set<string>();
      names.add(variable.getName());
      exported.set(source.getFilePath(), names);
    }
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

function transformFile(file: SourceFile, result: MigrationResult, exportedClients: Map<string, Set<string>>): void {
  const imported = new Set<string>();
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
  }
  for (const declaration of file.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const initializer = declaration.getInitializer();
    if (initializer && Node.isCallExpression(initializer) && initializer.getExpression().getText() === 'require'
      && initializer.getArguments()[0]?.getText().replace(/['"]/g, '') === 'openai') {
      if (Node.isIdentifier(declaration.getNameNode())) imported.add(declaration.getName());
      else addManual(result, file, declaration, 'Destructured require of openai needs manual binding review.');
    }
  }
  if (!file.getFullText().includes('openai')) return;
  if (file.getProject().getProgram().getSyntacticDiagnostics(file).some((item) => item.getCategory() === 1)) {
    result.manual.push({ file: file.getFilePath(), line: 1, reason: 'The source contains syntax errors; no OpenAI edits were applied.', snippet: '' });
    return;
  }
  const hasOpenAiModuleEvidence = file.getImportDeclarations().some((declaration) => declaration.getModuleSpecifierValue().includes('openai'))
    || file.getDescendantsOfKind(SyntaxKind.CallExpression).some((call) => {
      const argument = call.getArguments()[0];
      return (call.getExpression().getText() === 'require' || call.getExpression().getKind() === SyntaxKind.ImportKeyword)
        && argument && Node.isStringLiteral(argument) && argument.getLiteralValue().includes('openai');
    });
  // v5 removes this helper. It may be imported, re-exported, destructured from
  // require(), or accessed through a namespace/computed property. Never move
  // the module path while a reference remains: the new module has no export.
  const removedUploadHelper = file.getDescendants().find((node) =>
    (Node.isIdentifier(node) || Node.isStringLiteral(node)) &&
    (Node.isStringLiteral(node) ? node.getLiteralText() : node.getText()) === 'fileFromPath');
  if (removedUploadHelper) {
    addManual(result, file, removedUploadHelper,
      'OpenAI v5 removed fileFromPath; choose a supported upload helper manually. No edits were applied to this file.');
  }
  const clients = new Set<MorphSymbol>();
  const complexClients = new Set<MorphSymbol>();
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
    if (!source) continue;
    const exportedNames = exportedClients.get(source.getFilePath());
    if (!exportedNames) continue;
    for (const named of declaration.getNamedImports()) {
      if (!exportedNames.has(named.getName())) continue;
      const symbol = (named.getAliasNode() ?? named.getNameNode()).getSymbol();
      if (symbol) clients.add(symbol);
    }
  }
  const classFields = new Map<Node, Set<string>>();
  const clientFactorySymbols = new Set<MorphSymbol>();
  const isClientType = (type: Node | undefined): boolean => {
    if (!type) return false;
    const parts = type.getText().replace(/\s/g, '').split('|');
    return parts.some((part) => imported.has(part))
      && parts.every((part) => imported.has(part) || part === 'undefined' || part === 'null');
  };
  const isRunsSubresourceType = (type: Node | undefined): boolean => Boolean(type
    && [...imported].some((name) => new RegExp(`\\b${name}\\.Beta\\.Threads\\.Runs\\b`).test(type.getText())));
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
    } else if (type && [...imported].some((name) => new RegExp(`\\b${name}\\b`).test(type.getText()))) {
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
    else if (type && [...imported].some((name) => new RegExp(`\\b${name}\\b`).test(type.getText()))) {
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
      && [...imported].some((name) => new RegExp(`\\b${name}\\b`).test(variable.getTypeNode()!.getText()))) {
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
  for (const assignment of file.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    if (assignment.getOperatorToken().getKind() !== SyntaxKind.EqualsToken || !Node.isIdentifier(assignment.getLeft())) continue;
    const symbol = assignment.getLeft().getSymbol();
    if (!symbol) continue;
    const values = assignments.get(symbol) ?? [];
    values.push(assignment.getRight());
    assignments.set(symbol, values);
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
      const onlyTrackedClients = values.every((value) => {
        const unwrapped = unwrapTransparentExpression(value);
        if (Node.isIdentifier(unwrapped)) {
          const source = unwrapped.getSymbol();
          return Boolean(source && clients.has(source));
        }
        return Node.isNewExpression(unwrapped) && imported.has(unwrapped.getExpression().getText());
      });
      if (onlyTrackedClients) { clients.add(symbol); changed = true; }
    }
    if (!changed) break;
  }
  const clientParts = (node: Node): string[] | undefined => {
    const unwrapped = unwrapTransparentExpression(node);
    if (unwrapped !== node) return clientParts(unwrapped);
    if (Node.isIdentifier(node)) {
      const symbol = node.getSymbol();
      const scope = symbol ? narrowedClientScopes.get(symbol) : undefined;
      const narrowedHere = Boolean(scope && (node === scope || node.getParent() === scope || scope.getDescendants().includes(node)));
      return symbol && (clients.has(symbol) || narrowedHere)
      ? clientPrefixes.get(node.getSymbol()!) ?? [] : undefined;
    }
    if (Node.isElementAccessExpression(node)) return undefined;
    if (!Node.isPropertyAccessExpression(node)) return undefined;
    if (node.getExpression().getKind() === SyntaxKind.ThisKeyword) {
      if (!isClassThisBinding(node)) return undefined;
      const owner = node.getFirstAncestor((ancestor) => Node.isClassDeclaration(ancestor) || Node.isClassExpression(ancestor));
      return owner && classFields.get(owner)?.has(node.getName()) ? [] : undefined;
    }
    const parent = clientParts(node.getExpression());
    return parent ? [...parent, node.getName()] : undefined;
  };
  const runners = new Set<MorphSymbol>();
  for (const variable of file.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const initializer = variable.getInitializer();
    if (!initializer || !Node.isCallExpression(initializer)) continue;
    const runExpression = initializer.getExpression();
    if (!Node.isPropertyAccessExpression(runExpression)) continue;
    const root = rootIdentifier(runExpression);
    if (runExpression.getName() === 'runTools' && clientParts(runExpression)) {
      const symbol = variable.getNameNode().getSymbol();
      if (symbol) runners.add(symbol);
    }
  }
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
    if (root?.getSymbol() && clients.has(root.getSymbol()!) && pathParts(initializer).length >= 2) {
      addManual(result, file, variable, 'A destructured or aliased OpenAI subclient needs manual review of its v5 methods.');
    }
  }
  for (const declaration of file.getImportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue();
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
    if (moved && !hasRemovedUploadsExport && !(specifier === 'openai/uploads' && removedUploadHelper)) {
      addEdit(edits, file, declaration.getModuleSpecifier(), `'${moved}'`, 'moved-import');
      if (specifier === 'openai/resources/beta/threads/messages/messages') {
        const namespace = declaration.getNamespaceImport();
        const namespaceSymbol = namespace?.getSymbol();
        if (namespaceSymbol) messageNamespaceImports.add(namespaceSymbol);
        for (const entry of declaration.getNamedImports()) {
          const renamed = MOVED_MESSAGE_TYPES.get(entry.getName());
          if (!renamed) continue;
          const localName = entry.getAliasNode()?.getText() ?? entry.getName();
          const typePrefix = declaration.isTypeOnly() ? '' : 'type ';
          const alias = localName === renamed ? '' : ` as ${localName}`;
          addEdit(edits, file, entry, `${typePrefix}${renamed}${alias}`, 'moved-import');
        }
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
    if (moved && !hasRemovedUploadsExport && !(specifier === 'openai/uploads' && removedUploadHelper) && declaration.getModuleSpecifier()) {
      addEdit(edits, file, declaration.getModuleSpecifier()!, `'${moved}'`, 'moved-import');
      if (specifier === 'openai/resources/beta/threads/messages/messages') {
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
  }
  for (const importType of file.getDescendantsOfKind(SyntaxKind.ImportType)) {
    const argument = importType.getArgument();
    const rawSpecifier = argument.getText();
    if (!/^(['"]).*\1$/.test(rawSpecifier)) continue;
    const specifier = rawSpecifier.slice(1, -1);
    const moved = MOVED_IMPORTS.get(specifier);
    if (moved) {
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
  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expression = call.getExpression();
    if (Node.isPropertyAccessExpression(expression) && ['nextPageParams', 'nextPageInfo'].includes(expression.getName()))
      addManual(result, file, call, 'OpenAI v5 pagination uses nextPageRequestOptions; review manual pagination logic.');
    if (Node.isPropertyAccessExpression(expression) && expression.getName() === 'pipe'
      && file.getFullText().includes('.asResponse()') && expression.getExpression().getText().endsWith('.body'))
      addManual(result, file, call, 'OpenAI v5 Web response body is a ReadableStream; use a deliberate Web-to-Node stream conversion.');
    if (expression.getText() === 'require') {
      const argument = call.getArguments()[0];
      const specifier = argument?.getText().replace(/^['"]|['"]$/g, '');
      const moved = specifier ? MOVED_IMPORTS.get(specifier) : undefined;
      const declaration = call.getParentIfKind(SyntaxKind.VariableDeclaration);
      const binding = declaration?.getNameNode();
      const hasRemovedUploadsExport = specifier === 'openai/uploads' && binding && Node.isObjectBindingPattern(binding)
        && binding.getElements().some((element) => REMOVED_UPLOAD_EXPORTS.has(
          element.getPropertyNameNode()?.getText() ?? element.getNameNode().getText()));
      if (moved && argument && !hasRemovedUploadsExport && !(specifier === 'openai/uploads' && removedUploadHelper))
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
      const targetMethod = clientParts(wrappedTarget)?.join('.') ?? pathParts(wrappedTarget).slice(1).join('.');
      const computedTarget = Node.isElementAccessExpression(wrappedTarget)
        || wrappedTarget.getDescendantsOfKind(SyntaxKind.ElementAccessExpression).length > 0;
      const targetRoot = rootIdentifier(wrappedTarget)?.getSymbol();
      if (isAffectedMethod(targetMethod) || (computedTarget && (Boolean(targetRoot && clients.has(targetRoot)) || hasOpenAiModuleEvidence)))
        addManual(result, file, call, 'OpenAI v5 changes this method, but .call/.apply/.bind obscures its receiver and arguments; review it manually.');
      continue;
    }
    if (Node.isElementAccessExpression(expression)) {
      const possibleMethod = pathParts(expression).slice(1).join('.');
      const root = rootIdentifier(expression)?.getSymbol();
      if (isAffectedMethod(possibleMethod) || Boolean(root && clients.has(root)) || hasOpenAiModuleEvidence)
        addManual(result, file, call, 'OpenAI v5 changes this method, but computed receiver access requires manual review.');
      continue;
    }
    if (!Node.isPropertyAccessExpression(expression)) continue;
    if (expression.getName() === 'withResponse' || expression.getName() === 'asResponse') {
      addManual(result, file, call, 'OpenAI v5 Web response helpers return standard Web response types; review Headers and ReadableStream handling.');
    }
    const receiver = rootIdentifier(expression);
    const onRunner = Boolean(receiver?.getSymbol() && runners.has(receiver.getSymbol()!)) || expression.getText().includes('.runTools(');
    if (onRunner && expression.getName() === 'on') {
      const eventNode = call.getArguments()[0];
      const replacement = eventNode && Node.isStringLiteral(eventNode)
        ? RUN_TOOLS_EVENTS.get(eventNode.getLiteralText()) : undefined;
      if (replacement && eventNode) {
        const quote = eventNode.getText().startsWith('"') ? '"' : "'";
        addEdit(edits, file, eventNode, `${quote}${replacement}${quote}`, 'run-tools-event');
      } else if (eventNode && !Node.isStringLiteral(eventNode))
        addManual(result, file, eventNode, 'A runTools event name passed indirectly needs manual review against the v5 event names.');
    }
    const parts = clientParts(expression);
    if (!parts || parts.length < 2) {
      const possibleMethod = pathParts(expression).slice(1).join('.');
      const root = rootIdentifier(expression);
      const declarations = root?.getSymbol()?.getDeclarations() ?? [];
      const definitelyOtherReceiver = declarations.length > 0 && declarations.every((declaration) => {
        const type = Node.isParameterDeclaration(declaration) || Node.isVariableDeclaration(declaration)
          ? declaration.getTypeNode() : undefined;
        return Boolean(type && ![...imported].some((name) => new RegExp(`\\b${name}\\b`).test(type.getText())));
      });
      const hasComputedPath = Node.isElementAccessExpression(expression)
        || expression.getDescendantsOfKind(SyntaxKind.ElementAccessExpression).length > 0;
      const rootSymbol = root?.getSymbol();
      if ((isAffectedMethod(possibleMethod) || (hasComputedPath
        && (Boolean(rootSymbol && clients.has(rootSymbol)) || hasOpenAiModuleEvidence))) && !definitelyOtherReceiver)
        addManual(result, file, call, 'OpenAI v5 changes this method, but its client receiver is not tracked safely; review the receiver and arguments manually.');
      if (root?.getSymbol() && complexClients.has(root.getSymbol()!) && isAffectedMethod(possibleMethod))
        addManual(result, file, call, 'valeur OpenAI non suivie : vérifier la variante de ce client avant la migration.');
      continue;
    }
    const method = parts.join('.');
    const namedPathKey = SAFE_NAMED_PATH_REWRITES.get(method);
    if (namedPathKey) {
      const args = call.getArguments();
      const safeShape = args.length === 2 && args.every(isStablePathArgument)
        && /^,\s*$/.test(file.getFullText().slice(args[0]!.getEnd(), args[1]!.getStart()));
      if (safeShape) {
        addEdit(edits, file, call,
          `${expression.getText()}(${args[1]!.getText()}, { ${namedPathKey}: ${args[0]!.getText()} })`,
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
      const runner = rootIdentifier(property);
      const tracked = Boolean(runner?.getSymbol() && runners.has(runner.getSymbol()!))
        || property.getText().includes('.runTools(');
      if (tracked) {
        const parent = property.getParent();
        if (parent && Node.isCallExpression(parent) && parent.getExpression() === property)
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
    for (const file of project.getSourceFiles()) transformFile(file, result, exportedClients);
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
