import { Node, SyntaxKind, type Project, type SourceFile } from 'ts-morph';
import type { Change, ManualItem, Migration, MigrationResult, PackageManifest } from '../../core/types.js';
import { guaranteesNodeMajor } from '../../core/node-range.js';

const GUIDE = 'https://github.com/openai/openai-node/blob/v5.0.0/MIGRATION.md';
const CHANGED_PATH_METHODS = new Set([
  'vectorStores.files.retrieve', 'vectorStores.files.update', 'vectorStores.files.delete',
  'vectorStores.files.content', 'vectorStores.fileBatches.retrieve', 'vectorStores.fileBatches.cancel',
  'vectorStores.fileBatches.listFiles', 'beta.threads.runs.retrieve', 'beta.threads.runs.update',
  'beta.threads.runs.cancel', 'beta.threads.runs.submitToolOutputs', 'beta.threads.runs.steps.retrieve',
  'beta.threads.runs.steps.list', 'beta.threads.messages.retrieve', 'beta.threads.messages.update',
  'beta.threads.messages.delete', 'evals.runs.retrieve', 'evals.runs.delete',
  'evals.runs.cancel', 'evals.runs.outputItems.retrieve', 'evals.runs.outputItems.list',
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
interface Edit { start: number; end: number; replacement: string; rule: string; before: string; line: number }

function pathParts(node: Node): string[] {
  if (Node.isIdentifier(node)) return [node.getText()];
  if (Node.isPropertyAccessExpression(node)) return [...pathParts(node.getExpression()), node.getName()];
  return [];
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
  for (const declaration of file.getImportDeclarations()) {
    if (declaration.getModuleSpecifierValue() === 'openai') {
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
      && initializer.getArguments()[0]?.getText().replace(/['"]/g, '') === 'openai') imported.add(declaration.getName());
  }
  if (imported.size === 0 && !file.getImportDeclarations().some((item) => item.getModuleSpecifierValue().startsWith('openai/'))) return;
  if (file.getPreEmitDiagnostics().some((item) => item.getCategory() === 1 && item.getCode() >= 1000 && item.getCode() < 2000)) {
    result.manual.push({ file: file.getFilePath(), line: 1, reason: 'The source contains syntax errors; no OpenAI edits were applied.', snippet: '' });
    return;
  }
  const clients = new Set<string>();
  for (const variable of file.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const initializer = variable.getInitializer();
    if (initializer && Node.isNewExpression(initializer) && imported.has(initializer.getExpression().getText())) clients.add(variable.getName());
    // A client may be assigned in branches after its declaration. Its explicit
    // imported OpenAI type still identifies the receiver without guessing from
    // an arbitrary property name.
    if (Node.isIdentifier(variable.getNameNode()) && imported.has(variable.getTypeNode()?.getText() ?? ''))
      clients.add(variable.getName());
  }
  const edits: Edit[] = [];
  const manualStart = result.manual.length;
  for (const declaration of file.getImportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue();
    const moved = MOVED_IMPORTS.get(specifier);
    if (moved) addEdit(edits, file, declaration.getModuleSpecifier(), `'${moved}'`, 'moved-import');
    else if (specifier.startsWith('openai/shims/') || specifier.startsWith('openai/src/'))
      addManual(result, file, declaration, 'OpenAI v5 removes this private or shim import; review the replacement and runtime configuration.');
  }
  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expression = call.getExpression();
    if (!Node.isPropertyAccessExpression(expression)) continue;
    const parts = pathParts(expression);
    if (parts.length < 3 || !clients.has(parts[0]!)) continue;
    const method = parts.slice(1).join('.');
    if (method.endsWith('.runFunctions')) {
      addManual(result, file, call, 'OpenAI v5 removes runFunctions; migrate function definitions and handling to runTools manually.');
    } else if (CHANGED_PATH_METHODS.has(method) && call.getArguments().length >= 2) {
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
    if (root.length === 1 && clients.has(root[0]!)) addEdit(edits, file, beta, root[0]!, 'beta-chat');
  }
  for (const property of file.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    if (property.getName() !== 'httpAgent') continue;
    const parent = property.getParentIfKind(SyntaxKind.ObjectLiteralExpression);
    const constructor = parent?.getParent();
    if (constructor && Node.isNewExpression(constructor) && imported.has(constructor.getExpression().getText()))
      addManual(result, file, property, 'httpAgent uses a different transport from fetchOptions in OpenAI v5; configure it manually.');
  }
  if (result.manual.length !== manualStart) return;
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
