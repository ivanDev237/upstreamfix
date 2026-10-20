import { Node, SyntaxKind, type Identifier, type Project, type SourceFile } from 'ts-morph';
import type { Change, ManualItem, Migration, MigrationResult, PackageManifest } from '../core/types.js';
import { guaranteesNodeMajor } from '../core/node-range.js';

export interface RecipeRule {
  kind: 'export-rename' | 'import-move' | 'namespace-call' | 'chained-namespace-call' | 'namespace-property' | 'method-rename' | 'manual-namespace-call';
  id: string;
  name: string;
  to?: string;
  from?: string;
  receiver?: string;
  via?: string;
  message?: string;
  noArguments?: boolean;
}

export interface RecipeDefinition {
  schemaVersion: 1;
  id: string;
  package: string;
  fromMajor: number;
  toMajor: number;
  releasedAt: string;
  title: string;
  guideUrl: string;
  nodeMajor: number;
  rules: RecipeRule[];
}

interface Edit { start: number; end: number; text: string; line: number; before: string; rule: string }
interface Alias { name: Identifier; kind: 'esm' | 'cjs' }

function applyEdits(source: string, edits: Edit[]): string {
  let changed = source;
  for (const edit of [...edits].sort((left, right) => right.start - left.start || right.end - left.end)) {
    changed = changed.slice(0, edit.start) + edit.text + changed.slice(edit.end);
  }
  return changed;
}

function endOfLine(source: string, end: number): number {
  return source.slice(end, end + 2) === '\r\n' ? end + 2 : source[end] === '\n' ? end + 1 : end;
}

function quoteOf(sourceFile: SourceFile): string {
  const specifier = sourceFile.getImportDeclarations()[0]?.getModuleSpecifier().getText();
  if (specifier?.startsWith("'")) return "'";
  if (specifier?.startsWith('"')) return '"';
  const source = sourceFile.getFullText();
  return (source.match(/'/g) ?? []).length >= (source.match(/"/g) ?? []).length ? "'" : '"';
}

function importInsertion(sourceFile: SourceFile): number {
  const firstImport = sourceFile.getImportDeclarations()[0];
  if (firstImport) return firstImport.getStart();
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

function aliasDeclarations(sourceFile: SourceFile, packageName: string): Alias[] {
  const aliases: Alias[] = [];
  for (const declaration of sourceFile.getImportDeclarations()) {
    if (declaration.getModuleSpecifierValue() !== packageName) continue;
    const name = declaration.getNamespaceImport() ?? declaration.getDefaultImport();
    if (name) aliases.push({ name, kind: 'esm' });
  }
  for (const declaration of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const initializer = declaration.getInitializer();
    if (!Node.isCallExpression(initializer) || initializer.getExpression().getText() !== 'require') continue;
    const argument = initializer.getArguments()[0];
    if (!Node.isStringLiteral(argument) || argument.getLiteralValue() !== packageName) continue;
    const name = declaration.getNameNode();
    if (Node.isIdentifier(name)) aliases.push({ name, kind: 'cjs' });
  }
  return aliases;
}

function addManual(result: MigrationResult, sourceFile: SourceFile, node: Node, reason: string): void {
  result.manual.push({
    file: sourceFile.getFilePath(), line: node.getStartLineNumber(), reason,
    snippet: (node.getFirstAncestor((ancestor) => Node.isStatement(ancestor)) ?? node).getText().split(/\r?\n/, 1)[0]!.slice(0, 120),
  } satisfies ManualItem);
}

function sourceTransform(project: Project, recipe: RecipeDefinition): MigrationResult {
  const result: MigrationResult = { changes: [], manual: [], filesChanged: [], fileUpdates: [] };
  for (const sourceFile of project.getSourceFiles()) {
    const file = sourceFile.getFilePath();
    if (((sourceFile.compilerNode as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? []).length > 0) {
      addManual(result, sourceFile, sourceFile, 'This source file has syntax errors and could not be analyzed safely.');
      continue;
    }
    const source = sourceFile.getFullText();
    const edits: Edit[] = [];
    const imports = new Map<string, Set<string>>();
    const aliases = aliasDeclarations(sourceFile, recipe.package);
    const aliasesByName = new Map(aliases.map((alias) => [alias.name.getText(), alias]));
    const initialManual = result.manual.length;
    for (const alias of aliases) {
      if (alias.kind !== 'cjs') continue;
      const declaration = alias.name.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
      const statement = declaration?.getVariableStatement();
      if (!statement || statement.getDeclarationList().getDeclarations().length !== 1 || statement.isExported()) {
        addManual(result, sourceFile, alias.name, 'The SDK binding is exported or shares its declaration with another value; review it manually.');
      }
    }
    for (const declaration of sourceFile.getExportDeclarations()) {
      if (declaration.getModuleSpecifierValue() === recipe.package) {
        addManual(result, sourceFile, declaration, 'Re-exports from the SDK root need manual review before upgrading.');
      }
    }
    const findRule = (kind: RecipeRule['kind'], name: string): RecipeRule | undefined =>
      recipe.rules.find((rule) => rule.kind === kind && rule.name === name);
    for (const declaration of sourceFile.getImportDeclarations()) {
      if (declaration.getModuleSpecifierValue() !== recipe.package) continue;
      if (!declaration.getDefaultImport() && !declaration.getNamespaceImport() && declaration.getNamedImports().length === 0) {
        addManual(result, sourceFile, declaration, 'A side-effect SDK import needs manual review.');
      }
      for (const specifier of declaration.getNamedImports()) {
        if (!findRule('export-rename', specifier.getName()) && !findRule('import-move', specifier.getName())) {
          addManual(result, sourceFile, specifier, `The ${specifier.getName()} SDK import has no safe recipe mapping.`);
        }
      }
    }
    for (const declaration of sourceFile.getDescendantsOfKind(SyntaxKind.ImportEqualsDeclaration)) {
      if (declaration.getText().includes(`'${recipe.package}'`) || declaration.getText().includes(`"${recipe.package}"`)) {
        addManual(result, sourceFile, declaration, 'An import-equals SDK binding needs manual review.');
      }
    }
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const argument = call.getArguments()[0];
      if (call.getExpression().getText() === 'require' && Node.isNoSubstitutionTemplateLiteral(argument) && argument.getLiteralValue() === recipe.package) {
        addManual(result, sourceFile, call, 'A backtick SDK require needs manual review before upgrading.');
        continue;
      }
      if (!Node.isStringLiteral(argument) || argument.getLiteralValue() !== recipe.package) continue;
      const isRequire = call.getExpression().getText() === 'require';
      const variable = call.getParent();
      const recognized = isRequire && Node.isVariableDeclaration(variable) && variable.getInitializer() === call && Node.isIdentifier(variable.getNameNode());
      if (!recognized) addManual(result, sourceFile, call, 'This SDK import or require form needs manual review.');
    }
    const neededImport = (module: string, name: string): void => {
      const names = imports.get(module) ?? new Set<string>();
      names.add(name);
      imports.set(module, names);
    };
    const addEdit = (node: Node, text: string, id: string): void => {
      edits.push({ start: node.getStart(), end: node.getEnd(), text, line: node.getStartLineNumber(), before: node.getText(), rule: id });
    };

    for (const reference of sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)) {
      const alias = aliasesByName.get(reference.getText());
      if (!alias || reference === alias.name) continue;
      // A same-name local binding is not the SDK alias. Avoid rewriting it.
      const declaredSymbol = alias.name.getSymbol();
      const parent = reference.getParent();
      if (declaredSymbol && reference.getSymbol() && reference.getSymbol() !== declaredSymbol &&
          !Node.isShorthandPropertyAssignment(parent) && !Node.isExportSpecifier(parent)) continue;
      const access = reference.getParent();
      if (!Node.isPropertyAccessExpression(access) || access.getExpression() !== reference) {
        addManual(result, sourceFile, reference, `The ${alias.name.getText()} SDK namespace is used in an unsupported form.`);
        continue;
      }
      const member = access.getName();
      const outer = access.getParent();
      const directCall = Node.isCallExpression(outer) && outer.getExpression() === access ? outer : undefined;
      const manual = directCall ? findRule('manual-namespace-call', member) : undefined;
      if (manual) {
        addManual(result, sourceFile, access, manual.message!);
        continue;
      }
      if (directCall) {
        const nested = directCall.getParent();
        const serviceAccess = Node.isPropertyAccessExpression(nested) && nested.getExpression() === directCall ? nested : undefined;
        const serviceCall = serviceAccess?.getParent();
        const chained = serviceAccess
          ? recipe.rules.find((candidate) => candidate.kind === 'chained-namespace-call' && candidate.via === member && candidate.name === serviceAccess.getName())
          : undefined;
        if (chained && serviceAccess && Node.isCallExpression(serviceCall) && serviceCall.getExpression() === serviceAccess) {
          if (directCall.getArguments().length > 0 || serviceCall.getArguments().length > 0) {
            addManual(result, sourceFile, serviceCall, `Chained ${member}.${serviceAccess.getName()} call has arguments; choose the equivalent API manually so its target is preserved.`);
          } else {
            addEdit(serviceCall, `${chained.to}()`, chained.id);
            neededImport(chained.from!, chained.to!);
          }
          continue;
        }
      }
      const callRule = directCall ? findRule('namespace-call', member) : undefined;
      if (callRule) {
        if (callRule.noArguments && directCall && directCall.getArguments().length > 0) {
          addManual(result, sourceFile, access, `The ${member} call has arguments; choose the equivalent API manually.`);
          continue;
        }
        if (directCall) {
          const nested = directCall.getParent();
          if (Node.isPropertyAccessExpression(nested) && nested.getExpression() === directCall) {
            addManual(result, sourceFile, nested, `The ${member} call is followed by a property access; review the nested API manually.`);
            continue;
          }
        }
        addEdit(access, callRule.to!, callRule.id);
        neededImport(callRule.from!, callRule.to!);
        continue;
      }
      const propertyRule = findRule('namespace-property', member);
      if (!directCall && propertyRule) {
        const parent = access.getParent();
        const writesProperty = (Node.isBinaryExpression(parent) && parent.getLeft() === access
          && /^(?:=|(?:\+|-|\*|\/|%|<<|>>|>>>|&|\||\^|\*\*|&&|\|\||\?\?)=)$/.test(parent.getOperatorToken().getText()))
          || ((Node.isPrefixUnaryExpression(parent) || Node.isPostfixUnaryExpression(parent))
            && [SyntaxKind.PlusPlusToken, SyntaxKind.MinusMinusToken].includes(parent.getOperatorToken()));
        if (writesProperty) {
          addManual(result, sourceFile, access, `The ${access.getText()} SDK property is written to; migrate this mutation manually.`);
          continue;
        }
        addEdit(access, propertyRule.to!, propertyRule.id);
        neededImport(propertyRule.from!, propertyRule.to!.replace(/\(\)$/, ''));
        continue;
      }
      addManual(result, sourceFile, access, `The ${access.getText()} SDK usage has no safe recipe mapping.`);
    }

    for (const declaration of sourceFile.getImportDeclarations()) {
      if (declaration.getModuleSpecifierValue() !== recipe.package) continue;
      for (const specifier of declaration.getNamedImports()) {
        const name = specifier.getName();
        const rename = findRule('export-rename', name);
        const move = findRule('import-move', name);
        if (!rename && !move) continue;
        if (rename && move) {
          addManual(result, sourceFile, specifier, 'Recipe rules overlap on this imported export.');
          continue;
        }
        if (move && (declaration.getNamedImports().length !== 1 || declaration.getDefaultImport() || declaration.getNamespaceImport() || declaration.isTypeOnly() || specifier.isTypeOnly())) {
          addManual(result, sourceFile, specifier, 'Moving a mixed or type-only import requires manual review.');
          continue;
        }
        const local = specifier.getAliasNode()?.getText() ?? name;
        if (rename) addEdit(specifier, `${specifier.isTypeOnly() ? 'type ' : ''}${rename.to} as ${local}`, rename.id);
        if (move) {
          const q = quoteOf(sourceFile);
          const replacement = `import { ${name}${local === name ? '' : ` as ${local}`} } from ${q}${move.from}${q};`;
          addEdit(declaration, replacement, move.id);
        }
      }
    }

    const importedReceivers = new Map<string, ReturnType<Identifier['getSymbol']>>();
    for (const declaration of sourceFile.getImportDeclarations()) {
      if (declaration.getModuleSpecifierValue() !== recipe.package) continue;
      const defaultName = declaration.getDefaultImport()?.getText();
      if (defaultName) importedReceivers.set(defaultName, declaration.getDefaultImport()?.getSymbol());
      for (const spec of declaration.getNamedImports()) importedReceivers.set(spec.getAliasNode()?.getText() ?? spec.getName(), (spec.getAliasNode() ?? spec.getNameNode()).getSymbol());
    }
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const access = call.getExpression();
      if (!Node.isPropertyAccessExpression(access) || !Node.isIdentifier(access.getExpression())) continue;
      const receiver = access.getExpression().getText();
      const rule = recipe.rules.find((candidate) => candidate.kind === 'method-rename' && candidate.receiver === receiver && candidate.name === access.getName());
      if (rule && importedReceivers.has(receiver)) {
        const symbol = importedReceivers.get(receiver);
        if (symbol && access.getExpression().getSymbol() !== symbol) continue;
        addEdit(access.getNameNode(), rule.to!, rule.id);
      }
    }

    if (result.manual.length > initialManual) continue;
    if (edits.length === 0) {
      const hasPackageReference = sourceFile.getImportDeclarations().some((declaration) => declaration.getModuleSpecifierValue() === recipe.package)
        || sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).some((call) => {
          const argument = call.getArguments()[0];
          return ['require', 'import'].includes(call.getExpression().getText())
            && (Node.isStringLiteral(argument) || Node.isNoSubstitutionTemplateLiteral(argument))
            && argument.getLiteralValue() === recipe.package;
        });
      if (hasPackageReference) addManual(result, sourceFile, sourceFile, 'This file references the SDK without a recognized recipe binding; inspect its usage manually.');
      continue;
    }
    for (const [module, names] of imports) {
      for (const name of names) {
        const existing = sourceFile.getImportDeclarations().some((declaration) => declaration.getModuleSpecifierValue() === module && !declaration.isTypeOnly() && declaration.getNamedImports().some((specifier) => !specifier.isTypeOnly() && specifier.getName() === name && (specifier.getAliasNode()?.getText() ?? name) === name));
        if (existing) continue;
        const collision = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier).some((identifier) => identifier.getText() === name && !edits.some((edit) => identifier.getStart() >= edit.start && identifier.getEnd() <= edit.end));
        if (collision) addManual(result, sourceFile, sourceFile, `Imported ${name} would collide with an existing identifier.`);
      }
    }
    if (result.manual.length > initialManual) continue;
    if (aliases.length > 0 && imports.size > 0) {
      const newline = source.includes('\r\n') ? '\r\n' : '\n';
      const quote = quoteOf(sourceFile);
      const kind = aliases.some((alias) => alias.kind === 'esm') ? 'esm' : 'cjs';
      const importLines: string[] = [];
      for (const module of [...imports.keys()].sort()) {
        const names = [...imports.get(module)!].sort();
        const missing = names.filter((name) => !sourceFile.getImportDeclarations().some((declaration) => declaration.getModuleSpecifierValue() === module && !declaration.isTypeOnly() && declaration.getNamedImports().some((specifier) => !specifier.isTypeOnly() && specifier.getName() === name && (specifier.getAliasNode()?.getText() ?? name) === name)));
        if (missing.length === 0) continue;
        importLines.push(kind === 'esm'
          ? `import { ${missing.join(', ')} } from ${quote}${module}${quote};`
          : `const { ${missing.join(', ')} } = require(${quote}${module}${quote});`);
      }
      if (importLines.length > 0) {
        const insertion = importInsertion(sourceFile);
        const before = source.slice(0, insertion);
        const after = source.slice(insertion);
        const prefix = before.length === 0 || before.endsWith('\n') ? '' : newline;
        const suffix = after.startsWith('\n') ? '' : newline;
        edits.push({ start: insertion, end: insertion, text: `${prefix}${importLines.join(newline)}${suffix}`, line: 1, before: '', rule: '' });
      }
      for (const alias of aliases) {
        const declaration = alias.name.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
        const variable = alias.name.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
        const removable = declaration ?? variable?.getVariableStatement();
        if (removable && (!declaration || declaration.getNamedImports().length === 0)) {
          edits.push({ start: removable.getStart(), end: endOfLine(source, removable.getEnd()), text: '', line: 1, before: '', rule: '' });
        }
      }
    }
    const ordered = [...edits].filter((edit) => edit.start !== edit.end).sort((left, right) => left.start - right.start || left.end - right.end);
    let boundary = -1;
    for (const edit of ordered) {
      if (edit.start < boundary) {
        addManual(result, sourceFile, sourceFile, 'Automatic SDK edits overlap in this file; review it manually.');
        break;
      }
      boundary = Math.max(boundary, edit.end);
    }
    if (result.manual.length > initialManual) continue;
    const changed = applyEdits(source, edits);
    if (changed === source) continue;
    const parsePath = file.replace(/(\.[cm]?[jt]sx?)$/i, '.upstreamfix-parse$1');
    const parsed = project.createSourceFile(parsePath, changed, { overwrite: true });
    const hasSyntaxErrors = ((parsed.compilerNode as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? []).length > 0;
    project.removeSourceFile(parsed);
    if (hasSyntaxErrors) {
      addManual(result, sourceFile, sourceFile, 'The generated source has syntax errors; review this migration manually.');
      continue;
    }
    for (const alias of aliases) {
      const escaped = alias.name.getText().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(?<![\\w$])${escaped}\\s*[.\\[]`).test(changed)) {
        addManual(result, sourceFile, alias.name, `The ${alias.name.getText()} namespace still has references after migration; review this file manually.`);
      }
    }
    if (result.manual.length > initialManual) continue;
    for (const edit of edits) if (edit.rule) result.changes.push({ file, line: edit.line, rule: edit.rule, before: edit.before, after: edit.text } satisfies Change);
    result.filesChanged.push(file);
    result.fileUpdates!.push({ file, contents: changed });
  }
  return result;
}

export function createRecipeMigration(recipe: RecipeDefinition): Migration {
  return {
    id: recipe.id,
    packageName: recipe.package,
    fromMajor: recipe.fromMajor,
    toMajor: recipe.toMajor,
    releasedAt: recipe.releasedAt,
    title: recipe.title,
    guideUrl: recipe.guideUrl,
    rules: [...new Set(recipe.rules.map((rule) => rule.id))],
    experimental: true,
    declarativeRecipe: true,
    requiredNodeMajor: recipe.nodeMajor,
    transform: (project) => sourceTransform(project, recipe),
    inspectManifest: (manifest) => guaranteesNodeMajor(manifest.engines?.node ?? '', recipe.nodeMajor)
      ? [] : [`${recipe.package} v${recipe.toMajor} requires Node.js ${recipe.nodeMajor} or later; declare a compatible engines.node range before applying this recipe.`],
    updateManifest(manifest: PackageManifest): string[] {
      const notes: string[] = [];
      if (!guaranteesNodeMajor(manifest.engines?.node ?? '', recipe.nodeMajor)) {
        notes.push(`${recipe.package} v${recipe.toMajor} requires Node.js ${recipe.nodeMajor} or later; package.json was left unchanged.`);
        return notes;
      }
      for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
        const current = manifest[section]?.[recipe.package];
        if (!current) continue;
        if (!new RegExp(`^\\s*[~^]?${recipe.fromMajor}(?:\\.(?:\\d+|x|\\*)){0,2}\\s*$`, 'i').test(current)) {
          notes.push(`Cannot safely upgrade ${section}.${recipe.package} from ${current}; review its range manually.`);
          continue;
        }
        const target = `^${recipe.toMajor}.0.0`;
        manifest[section]![recipe.package] = target;
        notes.push(`\`${section}.${recipe.package}\`: \`${current}\` → \`${target}\``);
      }
      return notes;
    },
  };
}
