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
]);
const RUN_TOOLS_EVENTS = new Map([
  ['functionCall', 'functionToolCall'], ['functionCallResult', 'functionToolCallResult'],
  ['finalFunctionCall', 'finalFunctionToolCall'], ['finalFunctionCallResult', 'finalFunctionToolCallResult'],
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
  for (const parameter of file.getDescendantsOfKind(SyntaxKind.Parameter)) {
    if (imported.has(parameter.getTypeNode()?.getText() ?? '')) {
      const symbol = parameter.getNameNode().getSymbol();
      if (symbol) clients.add(symbol);
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
    if (Node.isIdentifier(variable.getNameNode()) && imported.has(variable.getTypeNode()?.getText() ?? '')) {
      const symbol = variable.getNameNode().getSymbol();
      if (symbol) clients.add(symbol);
    }
  }
  const runners = new Set<MorphSymbol>();
  for (const variable of file.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const initializer = variable.getInitializer();
    if (!initializer || !Node.isCallExpression(initializer)) continue;
    const runExpression = initializer.getExpression();
    if (!Node.isPropertyAccessExpression(runExpression)) continue;
    const root = rootIdentifier(runExpression);
    if (runExpression.getName() === 'runTools' && root?.getSymbol() && clients.has(root.getSymbol()!)) {
      const symbol = variable.getNameNode().getSymbol();
      if (symbol) runners.add(symbol);
    }
  }
  for (const constructor of file.getDescendantsOfKind(SyntaxKind.NewExpression)) {
    const parent = constructor.getParent();
    const assignedKnownClient = parent && Node.isBinaryExpression(parent) && parent.getOperatorToken().getKind() === SyntaxKind.EqualsToken
      && Node.isIdentifier(parent.getLeft()) && Boolean(parent.getLeft().getSymbol() && clients.has(parent.getLeft().getSymbol()!));
    if (imported.has(constructor.getExpression().getText()) && !Node.isVariableDeclaration(parent) && !assignedKnownClient) {
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
    const moved = MOVED_IMPORTS.get(specifier);
    if (moved) addEdit(edits, file, declaration.getModuleSpecifier(), `'${moved}'`, 'moved-import');
    else if (specifier.startsWith('openai/shims/') || specifier.startsWith('openai/src/'))
      addManual(result, file, declaration, 'OpenAI v5 removes this private or shim import; review the replacement and runtime configuration.');
  }
  for (const declaration of file.getExportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue();
    const moved = specifier ? MOVED_IMPORTS.get(specifier) : undefined;
    if (moved && declaration.getModuleSpecifier()) addEdit(edits, file, declaration.getModuleSpecifier()!, `'${moved}'`, 'moved-import');
  }
  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expression = call.getExpression();
    if (expression.getText() === 'require') {
      const argument = call.getArguments()[0];
      const specifier = argument?.getText().replace(/^['"]|['"]$/g, '');
      const moved = specifier ? MOVED_IMPORTS.get(specifier) : undefined;
      if (moved && argument) addEdit(edits, file, argument, `'${moved}'`, 'moved-import');
    }
    if (!Node.isPropertyAccessExpression(expression)) continue;
    const receiver = rootIdentifier(expression);
    const onRunner = Boolean(receiver?.getSymbol() && runners.has(receiver.getSymbol()!)) || expression.getText().includes('.runTools(');
    if (onRunner && expression.getName() === 'on') {
      const event = call.getArguments()[0]?.getText().replace(/^['"]|['"]$/g, '');
      const replacement = event ? RUN_TOOLS_EVENTS.get(event) : undefined;
      if (replacement) addManual(result, file, call, `OpenAI v5 renames runTools event ${event} to ${replacement}; review the listener manually.`);
    } else if (onRunner && expression.getName().startsWith('finalFunctionCall')) {
      addManual(result, file, call, `OpenAI v5 renames ${expression.getName()} to ${expression.getName().replace('FunctionCall', 'FunctionToolCall')}; review the returned value manually.`);
    }
    const parts = pathParts(expression);
    const root = rootIdentifier(expression);
    if (parts.length < 3 || !root?.getSymbol() || !clients.has(root.getSymbol()!)) continue;
    const method = parts.slice(1).join('.');
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
    if (property.getName() !== 'chat') continue;
    const parent = property.getParentIfKind(SyntaxKind.PropertyAccessExpression);
    if (!parent || parent.getName() !== 'completions') continue;
    const beta = property.getExpression();
    if (!Node.isPropertyAccessExpression(beta) || beta.getName() !== 'beta') continue;
    const root = pathParts(beta.getExpression());
    const rootNode = rootIdentifier(beta.getExpression());
    if (root.length === 1 && rootNode?.getSymbol() && clients.has(rootNode.getSymbol()!)) addEdit(edits, file, beta, root[0]!, 'beta-chat');
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
