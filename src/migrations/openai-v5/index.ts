import { Node, SyntaxKind, type Project, type SourceFile, type Symbol as MorphSymbol } from 'ts-morph';
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
  if (Node.isIdentifier(node)) return [node.getText()];
  if (Node.isPropertyAccessExpression(node)) return [...pathParts(node.getExpression()), node.getName()];
  return [];
}

function rootIdentifier(node: Node): Node | undefined {
  if (Node.isIdentifier(node)) return node;
  if (Node.isPropertyAccessExpression(node)) return rootIdentifier(node.getExpression());
  return undefined;
}

function addManual(result: MigrationResult, file: SourceFile, node: Node, reason: string): void {
  result.manual.push({ file: file.getFilePath(), line: file.getLineAndColumnAtPos(node.getStart()).line,
    reason, snippet: node.getText().slice(0, 500) });
}

function addEdit(edits: Edit[], file: SourceFile, node: Node, replacement: string, rule: string): void {
  edits.push({ start: node.getStart(), end: node.getEnd(), before: node.getText(), replacement, rule,
    line: file.getLineAndColumnAtPos(node.getStart()).line });
}

function transformFile(file: SourceFile, result: MigrationResult): void {
  const imported = new Set<string>();
  const edits: Edit[] = [];
  const manualStart = result.manual.length;
  const typedSource = /\.[cm]?tsx?$/.test(file.getFilePath());
  for (const declaration of file.getImportDeclarations()) {
    if (declaration.getModuleSpecifierValue() === 'openai') {
      if (declaration.getNamespaceImport()) addManual(result, file, declaration, 'OpenAI namespace imports require manual review because receiver bindings cannot be proven safe.');
      const name = declaration.getDefaultImport()?.getText();
      if (name) imported.add(name);
      for (const named of declaration.getNamedImports()) {
        if (named.getName() === 'OpenAI') imported.add(named.getAliasNode()?.getText() ?? 'OpenAI');
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
  const classFields = new Map<Node, Set<string>>();
  const isClientType = (type: Node | undefined): boolean => {
    if (!type) return false;
    const parts = type.getText().replace(/\s/g, '').split('|');
    return parts.some((part) => imported.has(part))
      && parts.every((part) => imported.has(part) || part === 'undefined' || part === 'null');
  };
  const rememberField = (node: Node, name: string): void => {
    const owner = node.getFirstAncestor((ancestor) => Node.isClassDeclaration(ancestor) || Node.isClassExpression(ancestor));
    if (!owner) return;
    const fields = classFields.get(owner) ?? new Set<string>();
    fields.add(name);
    classFields.set(owner, fields);
  };
  for (const parameter of file.getDescendantsOfKind(SyntaxKind.Parameter)) {
    const type = parameter.getTypeNode();
    if (isClientType(type)) {
      if (Node.isIdentifier(parameter.getNameNode())) {
        const symbol = parameter.getNameNode().getSymbol();
        if (symbol) clients.add(symbol);
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
    const initializer = variable.getInitializer();
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
  }
  const clientParts = (node: Node): string[] | undefined => {
    if (Node.isIdentifier(node)) return node.getSymbol() && clients.has(node.getSymbol()!) ? [] : undefined;
    if (!Node.isPropertyAccessExpression(node)) return undefined;
    if (node.getExpression().getKind() === SyntaxKind.ThisKeyword) {
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
    if (imported.has(constructor.getExpression().getText()) && !Node.isVariableDeclaration(parent)
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
    if (specifier === 'openai/uploads') {
      for (const entry of declaration.getNamedImports()) {
        if (REMOVED_UPLOAD_EXPORTS.has(entry.getName()))
          addManual(result, file, entry, `OpenAI v5 removes uploads export ${entry.getName()}; choose a supported replacement manually.`);
      }
    }
    const moved = MOVED_IMPORTS.get(specifier);
    if (moved) addEdit(edits, file, declaration.getModuleSpecifier(), `'${moved}'`, 'moved-import');
    else if (specifier === 'openai/shims' || specifier === 'openai/src' || specifier.startsWith('openai/shims/') || specifier.startsWith('openai/src/'))
      addManual(result, file, declaration, 'OpenAI v5 removes this private or shim import; review the replacement and runtime configuration.');
    if (specifier.startsWith('openai/resources/') && declaration.getNamedImports().some((entry) => /Page$/.test(entry.getName()) && !declaration.isTypeOnly() && !entry.isTypeOnly()))
      addManual(result, file, declaration, 'OpenAI v5 converts resource-specific Page classes to type aliases; review runtime uses before upgrading.');
    if (specifier.startsWith('openai/') && declaration.getNamedImports().some((entry) => entry.getName() === 'APIClient'))
      addManual(result, file, declaration, 'OpenAI v5 removes APIClient; review replacement with the main OpenAI class.');
    if (specifier === 'openai/core')
      addManual(result, file, declaration, 'OpenAI v5 refactors openai/core; review every imported export against the public v5 entry points.');
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
    if (specifier === 'openai/uploads') {
      for (const entry of declaration.getNamedExports()) {
        if (REMOVED_UPLOAD_EXPORTS.has(entry.getName()))
          addManual(result, file, entry, `OpenAI v5 removes uploads export ${entry.getName()}; review this public re-export manually.`);
      }
    }
    const moved = specifier ? MOVED_IMPORTS.get(specifier) : undefined;
    if (moved && declaration.getModuleSpecifier()) addEdit(edits, file, declaration.getModuleSpecifier()!, `'${moved}'`, 'moved-import');
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
      if (moved && argument) addEdit(edits, file, argument, `'${moved}'`, 'moved-import');
      if (specifier === 'openai/uploads') {
        const declaration = call.getParentIfKind(SyntaxKind.VariableDeclaration);
        const binding = declaration?.getNameNode();
        if (binding && Node.isObjectBindingPattern(binding)) {
          for (const element of binding.getElements()) {
            const name = element.getPropertyNameNode()?.getText() ?? element.getNameNode().getText();
            if (REMOVED_UPLOAD_EXPORTS.has(name))
              addManual(result, file, element, `OpenAI v5 removes uploads export ${name}; review this CommonJS binding manually.`);
          }
        }
      }
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
      const root = rootIdentifier(expression);
      if (root?.getSymbol() && complexClients.has(root.getSymbol()!)
        && (expression.getName() === 'del' || expression.getText().includes('.beta.chat.')))
        addManual(result, file, call, 'valeur OpenAI non suivie : vérifier la variante de ce client avant la migration.');
      continue;
    }
    const method = parts.join('.');
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
  if (result.manual.length !== manualStart) {
    for (const edit of edits) {
      result.manual.push({ file: file.getFilePath(), line: edit.line,
        reason: `Potential ${edit.rule} transformation withheld because this file also contains manual findings.`, snippet: edit.before });
    }
    return;
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
    for (const file of project.getSourceFiles()) transformFile(file, result);
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
