import { Node, SyntaxKind, type Project, type SourceFile, type Symbol as MorphSymbol } from 'ts-morph';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Change, ManualItem, Migration, MigrationResult, PackageManifest } from '../../core/types.js';

type Edit = { start: number; end: number; replacement: string; rule: string; line: number; before: string };
const PACKAGE = '@getbrevo/brevo';
const LEGACY = 'sib-api-v3-sdk';
const V3_CLASSES = new Set(['TransactionalEmailsApi', 'SendSmtpEmail', 'ContactsApi', 'CampaignsApi', 'SMTPApi', 'AccountApi', 'WebhooksApi']);
const RESULT_CHANGES = new Set(['balance.getActiveBalancesApi', 'tasks.getAllTaskTypes', 'balance.getBalanceDefinitionList']);
const MESSAGE_METHODS = new Set(['conversations.sendAMessageAsAnAgent', 'conversations.sendAnAutomatedMessageToAVisitor']);
/** Names are deliberately checked on every called property, regardless of receiver. */
export const BREVO_V6_BREAKING_METHODS = new Set([
  'createBatchEvents', 'getActiveBalancesApi', 'getAllCompanies', 'getContactBalances',
  'getLoyaltyBalanceProgramsPidTransactionHistory', 'getTransactionHistoryApi',
  'getAllTaskTypes', 'getBalanceDefinitionList', 'postPreviewSmtpEmailTemplates',
  'exportWebhooksHistory', 'getLpList', 'createBalanceOrder',
  'postConversationsMessages', 'postConversationsPushedMessages',
  'sendAMessageAsAnAgent', 'sendAnAutomatedMessageToAVisitor', 'deleteTier', 'deleteTierGroup',
]);

function finding(file: SourceFile, node: Node, reason: string): ManualItem {
  return { file: file.getFilePath(), line: node.getStartLineNumber(), reason, snippet: '[Brevo usage; values omitted]' };
}

function unwrap(node: Node): Node {
  let current = node;
  while (Node.isParenthesizedExpression(current) || Node.isAsExpression(current)
    || Node.isTypeAssertion(current) || Node.isNonNullExpression(current) || Node.isSatisfiesExpression(current)) {
    current = current.getExpression();
  }
  return current;
}

function key(node: Node): string | undefined {
  if (Node.isPropertyAssignment(node) || Node.isShorthandPropertyAssignment(node)) {
    const name = node.getNameNode();
    if (Node.isIdentifier(name) || Node.isStringLiteral(name)) return name.getText().replace(/^['"]|['"]$/g, '');
  }
  return undefined;
}

function prop(object: Node, name: string): Node | undefined {
  if (!Node.isObjectLiteralExpression(object)) return undefined;
  return object.getProperties().find((item) => key(item) === name);
}

function value(property: Node | undefined): Node | undefined {
  return property && Node.isPropertyAssignment(property) ? property.getInitializer() : undefined;
}

function methodPath(node: Node): { root: Node; resource: string; method: string } | undefined {
  const call = unwrap(node);
  if (!Node.isPropertyAccessExpression(call)) return undefined;
  const resource = unwrap(call.getExpression());
  if (!Node.isPropertyAccessExpression(resource)) return undefined;
  return { root: unwrap(resource.getExpression()), resource: resource.getName(), method: call.getName() };
}

function isRequire(node: Node, packageName: string): boolean {
  if (!Node.isCallExpression(node) || node.getExpression().getText() !== 'require') return false;
  const first = node.getArguments()[0];
  return !!first && Node.isStringLiteral(first) && first.getLiteralText() === packageName;
}

function bindings(file: SourceFile): { constructors: Set<string>; clients: Map<MorphSymbol, string>; constructorSymbols: Map<string, MorphSymbol>; namespaceSymbols: Map<string, MorphSymbol>; allowedAssignments: Set<number>; classFields: Map<Node, Set<string>> } {
  const constructors = new Set<string>();
  const constructorSymbols = new Map<string, MorphSymbol>();
  const namespaceSymbols = new Map<string, MorphSymbol>();
  for (const declaration of file.getImportDeclarations()) {
    if (declaration.getModuleSpecifierValue() !== PACKAGE) continue;
    for (const specifier of declaration.getNamedImports()) if (specifier.getName() === 'BrevoClient') {
      const name = specifier.getAliasNode() ?? specifier.getNameNode();
      constructors.add(name.getText());
      if (name.getSymbol()) constructorSymbols.set(name.getText(), name.getSymbol()!);
    }
    if (declaration.getNamespaceImport()) {
      const namespace = declaration.getNamespaceImport()!;
      constructors.add(`${namespace.getText()}.BrevoClient`);
      if (namespace.getSymbol()) namespaceSymbols.set(namespace.getText(), namespace.getSymbol()!);
    }
  }
  for (const declaration of file.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const initializer = declaration.getInitializer();
    if (!initializer || !isRequire(initializer, PACKAGE)) continue;
    const name = declaration.getNameNode();
    if (Node.isObjectBindingPattern(name)) {
      for (const element of name.getElements()) if ((element.getPropertyNameNode()?.getText() ?? element.getNameNode().getText()) === 'BrevoClient') {
        const binding = element.getNameNode();
        constructors.add(binding.getText());
        if (binding.getSymbol()) constructorSymbols.set(binding.getText(), binding.getSymbol()!);
      }
    } else if (Node.isIdentifier(name)) {
      constructors.add(`${name.getText()}.BrevoClient`);
      if (name.getSymbol()) namespaceSymbols.set(name.getText(), name.getSymbol()!);
    }
  }
  const isConstructor = (expression: Node): boolean => {
    if (Node.isIdentifier(expression)) {
      const binding = constructorSymbols.get(expression.getText());
      return !!binding && binding.compilerSymbol === expression.getSymbol()?.compilerSymbol;
    }
    if (Node.isPropertyAccessExpression(expression) && expression.getName() === 'BrevoClient'
      && Node.isIdentifier(expression.getExpression())) {
      const namespace = expression.getExpression();
      const binding = namespaceSymbols.get(namespace.getText());
      return !!binding && binding.compilerSymbol === namespace.getSymbol()?.compilerSymbol;
    }
    return false;
  };
  const clients = new Map<MorphSymbol, string>();
  const allowedAssignments = new Set<number>();
  for (const declaration of file.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const initializer = declaration.getInitializer();
    const name = declaration.getNameNode();
    if (!Node.isIdentifier(name)) continue;
    const symbol = name.getSymbol();
    if (!symbol) continue;
    if (initializer && Node.isNewExpression(initializer) && isConstructor(initializer.getExpression())) {
      clients.set(symbol, name.getText());
      continue;
    }
    if (initializer && !Node.isNullLiteral(initializer)
      && !(Node.isIdentifier(initializer) && initializer.getText() === 'undefined')) continue;
    const writes = file.getDescendantsOfKind(SyntaxKind.BinaryExpression).filter((assignment) =>
      assignment.getOperatorToken().getKind() === SyntaxKind.EqualsToken
      && Node.isIdentifier(assignment.getLeft())
      && assignment.getLeft().getSymbol()?.compilerSymbol === symbol.compilerSymbol);
    if (writes.length === 0 || writes.some((assignment) => {
      const right = assignment.getRight();
      return !Node.isNewExpression(right) || !isConstructor(right.getExpression());
    })) continue;
    clients.set(symbol, name.getText());
    for (const assignment of writes) allowedAssignments.add(assignment.getLeft().getStart());
  }
  const classFields = new Map<Node, Set<string>>();
  for (const assignment of file.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    const right = assignment.getRight();
    if (assignment.getOperatorToken().getKind() !== SyntaxKind.EqualsToken
      || !Node.isNewExpression(right) || !isConstructor(right.getExpression())) continue;
    const left = unwrap(assignment.getLeft());
    if (!Node.isPropertyAccessExpression(left) || left.getExpression().getKind() !== SyntaxKind.ThisKeyword) continue;
    const member = assignment.getFirstAncestor((ancestor) => Node.isConstructorDeclaration(ancestor));
    const classNode = member?.getParent();
    if (!classNode || !Node.isClassDeclaration(classNode) && !Node.isClassExpression(classNode)) continue;
    const names = classFields.get(classNode) ?? new Set<string>();
    names.add(left.getName());
    classFields.set(classNode, names);
  }
  return { constructors, clients, constructorSymbols, namespaceSymbols, allowedAssignments, classFields };
}

function isV3(file: SourceFile): boolean {
  if (file.getImportDeclarations().some((item) => item.getModuleSpecifierValue() === LEGACY
    || item.getModuleSpecifierValue() === PACKAGE && item.getNamedImports().some((part) => V3_CLASSES.has(part.getName())))) return true;
  if (file.getDescendantsOfKind(SyntaxKind.CallExpression).some((call) => isRequire(call, LEGACY)
    || call.getExpression().getKind() === SyntaxKind.ImportKeyword
      && Node.isStringLiteral(call.getArguments()[0]) && call.getArguments()[0]!.getText().slice(1, -1) === LEGACY)) return true;
  if (file.getDescendantsOfKind(SyntaxKind.VariableDeclaration).some((declaration) => {
    const initializer = declaration.getInitializer();
    const name = declaration.getNameNode();
    return !!initializer && isRequire(initializer, PACKAGE) && Node.isObjectBindingPattern(name)
      && name.getElements().some((element) => V3_CLASSES.has(element.getPropertyNameNode()?.getText() ?? element.getNameNode().getText()));
  })) return true;
  return false;
}

function clientEscapes(file: SourceFile, symbol: MorphSymbol, allowedAssignments: Set<number>): boolean {
  const checker = file.getProject().getTypeChecker().compilerObject;
  for (const identifier of file.getDescendantsOfKind(SyntaxKind.Identifier)) {
    const parent = identifier.getParent();
    const reference = Node.isShorthandPropertyAssignment(parent)
      ? checker.getShorthandAssignmentValueSymbol(parent.compilerNode) ?? identifier.getSymbol()?.compilerSymbol
      : identifier.getSymbol()?.compilerSymbol;
    if (reference !== symbol.compilerSymbol) continue;
    if (Node.isVariableDeclaration(parent) && parent.getNameNode() === identifier) {
      const statement = parent.getFirstAncestorByKind(SyntaxKind.VariableStatement);
      if (statement?.isExported() || statement?.isDefaultExport()) return true;
      continue;
    }
    if (allowedAssignments.has(identifier.getStart()) && Node.isBinaryExpression(parent)
      && parent.getLeft() === identifier) continue;
    if (Node.isShorthandPropertyAssignment(parent)) return true;
    let use: Node = identifier;
    while (use.getParent() && (Node.isParenthesizedExpression(use.getParent()!) || Node.isAsExpression(use.getParent()!)
      || Node.isTypeAssertion(use.getParent()!) || Node.isNonNullExpression(use.getParent()!) || Node.isSatisfiesExpression(use.getParent()!))) use = use.getParent()!;
    const outer = use.getParent();
    if (Node.isPropertyAccessExpression(outer) && outer.getExpression() === use) {
      const next = outer.getParent();
      if (Node.isPropertyAccessExpression(next) && next.getExpression() === outer && Node.isCallExpression(next.getParent())
        && next.getParentIfKind(SyntaxKind.CallExpression)?.getExpression() === next) continue;
      return true;
    }
    if (Node.isElementAccessExpression(outer) && outer.getExpression() === use) return true;
    return true;
  }
  return false;
}

function classFieldEscapes(classNode: Node, field: string): boolean {
  for (const access of classNode.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    if (access.getName() !== field || access.getExpression().getKind() !== SyntaxKind.ThisKeyword) continue;
    const owner = access.getFirstAncestor((ancestor) => Node.isClassDeclaration(ancestor) || Node.isClassExpression(ancestor));
    if (owner !== classNode) continue;
    const parent = access.getParent();
    if (Node.isBinaryExpression(parent) && parent.getLeft() === access
      && parent.getOperatorToken().getKind() === SyntaxKind.EqualsToken
      && Node.isNewExpression(parent.getRight())) {
      const constructor = parent.getFirstAncestor((ancestor) => Node.isConstructorDeclaration(ancestor));
      if (constructor?.getParent() === classNode) continue;
    }
    if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === access) {
      const method = parent.getParent();
      if (Node.isPropertyAccessExpression(method) && method.getExpression() === parent
        && Node.isCallExpression(method.getParent()) && method.getParentIfKind(SyntaxKind.CallExpression)?.getExpression() === method) continue;
    }
    return true;
  }
  return false;
}

function thisBelongsToClass(node: Node, classNode: Node): boolean {
  let current = node.getParent();
  while (current && current !== classNode) {
    if (Node.isFunctionExpression(current) || Node.isFunctionDeclaration(current)) return false;
    current = current.getParent();
  }
  return current === classNode;
}

function edit(node: Node, replacement: string, rule: string): Edit {
  return { start: node.getStart(), end: node.getEnd(), replacement, rule, line: node.getStartLineNumber(), before: node.getText() };
}

function safeCompanyFilter(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  if (Node.isCallExpression(node) && node.getExpression().getText() === 'JSON.stringify') {
    const object = node.getArguments()[0];
    if (!object || !Node.isObjectLiteralExpression(object) || object.getProperties().length !== 1) return undefined;
    const only = object.getProperties()[0]!;
    if (key(only) !== 'attributes.name') return undefined;
    return value(only)?.getText();
  }
  if (Node.isStringLiteral(node)) {
    try {
      const parsed: unknown = JSON.parse(node.getLiteralText());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && Object.keys(parsed).length === 1 && typeof (parsed as Record<string, unknown>)['attributes.name'] === 'string')
        return JSON.stringify((parsed as Record<string, string>)['attributes.name']);
    } catch { /* Unknown filter representation is manual. */ }
  }
  return undefined;
}

function consumed(call: Node): boolean {
  let current = call;
  while (Node.isAwaitExpression(current.getParent()) || Node.isParenthesizedExpression(current.getParent())) current = current.getParent()!;
  const parent = current.getParent();
  return !Node.isExpressionStatement(parent) && !(Node.isVoidExpression(parent));
}

function sourceMajor(file: SourceFile): number | undefined {
  let directory = path.dirname(file.getFilePath());
  while (true) {
    const manifestPath = path.join(directory, 'package.json');
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest;
        const range = manifest.dependencies?.[PACKAGE] ?? manifest.devDependencies?.[PACKAGE]
          ?? manifest.peerDependencies?.[PACKAGE] ?? manifest.optionalDependencies?.[PACKAGE];
        const match = /^\s*[~^]?([45])(?:[.x*]|$)/.exec(range ?? '');
        return match ? Number(match[1]) : undefined;
      } catch { return undefined; }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function migrateFile(file: SourceFile, result: MigrationResult): void {
  if (isV3(file)) {
    result.manual.push(finding(file, file, 'Brevo migration v3 → v6 is not supported; see the official migration guide.'));
    return;
  }
  const breakingCalls = file.getDescendantsOfKind(SyntaxKind.CallExpression).filter((call) => {
    const expression = unwrap(call.getExpression());
    return Node.isPropertyAccessExpression(expression) && BREVO_V6_BREAKING_METHODS.has(expression.getName());
  });
  if (breakingCalls.length === 0) return;
  const { constructors, clients, allowedAssignments, classFields } = bindings(file);
  const escapingVariables = new Map<MorphSymbol, boolean>();
  const escapingFields = new Map<string, boolean>();
  for (const classDeclaration of file.getDescendantsOfKind(SyntaxKind.ClassDeclaration)) {
    if (classDeclaration.getExtends() && constructors.has(classDeclaration.getExtends()!.getExpression().getText()))
      result.manual.push(finding(file, classDeclaration, 'A BrevoClient subclass needs manual review before v6 migration.'));
  }
  for (const classExpression of file.getDescendantsOfKind(SyntaxKind.ClassExpression)) {
    if (classExpression.getExtends() && constructors.has(classExpression.getExtends()!.getExpression().getText()))
      result.manual.push(finding(file, classExpression, 'A BrevoClient subclass needs manual review before v6 migration.'));
  }
  const edits: Edit[] = [];
  for (const call of breakingCalls) {
    const method = methodPath(call.getExpression());
    if (!method) {
      const expression = unwrap(call.getExpression());
      if (Node.isPropertyAccessExpression(expression) && Node.isElementAccessExpression(unwrap(expression.getExpression())))
        result.manual.push(finding(file, call, 'A dynamic Brevo client resource cannot be migrated safely.'));
      else result.manual.push(finding(file, call, 'Brevo SDK usage could not be tied to a BrevoClient instance; review this breaking call before upgrading to v6.'));
      continue;
    }
    const variable = Node.isIdentifier(method.root) ? method.root.getSymbol() : undefined;
    const classRoot = Node.isPropertyAccessExpression(method.root) && method.root.getExpression().getKind() === SyntaxKind.ThisKeyword
      ? method.root : undefined;
    const classNode = classRoot?.getFirstAncestor((ancestor) => Node.isClassDeclaration(ancestor) || Node.isClassExpression(ancestor));
    const tiedVariable = variable && clients.has(variable);
    const tiedField = classRoot && classNode && classFields.get(classNode)?.has(classRoot.getName())
      && thisBelongsToClass(classRoot, classNode);
    if (!tiedVariable && !tiedField) {
      result.manual.push(finding(file, call, 'Brevo SDK usage could not be tied to a BrevoClient instance; review this breaking call before upgrading to v6.'));
      continue;
    }
    const name = `${method.resource}.${method.method}`;
    const manualBeforeCall = result.manual.length;
    const editsBeforeCall = edits.length;
    const argument = call.getArguments()[0];
    const object = argument && Node.isObjectLiteralExpression(argument) ? argument : undefined;
    const stop = (reason: string): void => { result.manual.push(finding(file, call, reason)); };
    const fieldKey = classNode && classRoot ? `${classNode.getStart()}:${classRoot.getName()}` : '';
    const escaped = tiedVariable && variable
      ? escapingVariables.get(variable) ?? clientEscapes(file, variable, allowedAssignments)
      : tiedField && classNode && classRoot
        ? escapingFields.get(fieldKey) ?? classFieldEscapes(classNode, classRoot.getName())
        : false;
    if (tiedVariable && variable) escapingVariables.set(variable, escaped);
    if (tiedField) escapingFields.set(fieldKey, escaped);
    if (escaped) { stop(`Brevo ${name} call uses a client that escapes this file or class; review it manually.`); continue; }
    if (RESULT_CHANGES.has(name) && consumed(call)) stop(`The result of ${name} changes type in Brevo v6; review every read manually.`);
    if (name === 'event.createBatchEvents') {
      if (argument && Node.isArrayLiteralExpression(argument)) edits.push(edit(argument, `{ events: ${argument.getText()} }`, 'batch-events-request'));
      else stop('createBatchEvents requires an object with events in v6; an opaque argument needs manual review.');
    }
    if (name === 'balance.getActiveBalancesApi') {
      if (!object) { stop('getActiveBalancesApi requires a direct object literal for safe v6 key migration.'); continue; }
      if (object.getProperties().some((property) => Node.isSpreadAssignment(property))) {
        stop('An active balance request spread can hide legacy keys or override v6 keys; review it manually.');
        continue;
      }
      const sortField = prop(object, 'sort_field');
      const sort = prop(object, 'sort');
      if ([['contact_id', 'contactId'], ['balance_definition_id', 'balanceDefinitionId'], ['sort_field', 'sortField']]
        .some(([oldName, newName]) => prop(object, oldName!) && prop(object, newName!))) {
        stop('The active balance request contains both old and new v6 keys; resolve the duplicate manually.');
        continue;
      }
      const sortFieldValue = value(sortField);
      if (sortField && (!sortFieldValue || !Node.isStringLiteral(sortFieldValue) || sortFieldValue.getLiteralText() !== 'createdAt'))
        { stop('getActiveBalancesApi.sortField accepts only literal "createdAt" in v6.'); continue; }
      if (sort && !Node.isStringLiteral(value(sort))) { stop('getActiveBalancesApi.sort is an enum in v6; review nonliteral values.'); continue; }
      for (const [oldName, newName] of [['contact_id', 'contactId'], ['balance_definition_id', 'balanceDefinitionId'], ['sort_field', 'sortField']]) {
        const property = prop(object, oldName);
        if (property && Node.isPropertyAssignment(property)) edits.push(edit(property.getNameNode(), newName, 'active-balance-request'));
        else if (property && Node.isShorthandPropertyAssignment(property))
          edits.push(edit(property, `${newName}: ${oldName}`, 'active-balance-request'));
      }
    }
    if (name === 'companies.getAllCompanies') {
      if (!object) { stop('getAllCompanies filters may be ignored in v6; inspect this opaque request manually.'); continue; }
      if (object.getProperties().some((property) => Node.isSpreadAssignment(property))) {
        stop('A spread may contain old companies filters; in v6, old filters is ignored and the list returns unfiltered without an error.');
        continue;
      }
      const filter = prop(object, 'filters');
      if (filter) {
        if (prop(object, 'filters[attributes.name]')) {
          stop('Both old and new company name filters are present; resolve the duplicate manually.');
          continue;
        }
        const replacement = safeCompanyFilter(value(filter));
        if (replacement === undefined) stop('In v6, the old companies filters is ignored by the server: the list returns unfiltered without an error. Review this filter manually.');
        else edits.push(edit(filter, `"filters[attributes.name]": ${replacement}`, 'companies-name-filter'));
      }
    }
    if (name === 'balance.getTransactionHistoryApi' && (!object || prop(object, 'filters')))
      stop('The transaction history filters parameter was removed in v6; review this request manually.');
    if (name === 'balance.getContactBalances' && (!object || !prop(object, 'balanceDefinitionId')))
      stop('getContactBalances now requires balanceDefinitionId in v6.');
    if (name === 'transactionalEmails.postPreviewSmtpEmailTemplates' && !argument)
      stop('postPreviewSmtpEmailTemplates now requires an argument in v6.');
    if (name === 'webhooks.exportWebhooksHistory' && (!object || Node.isNumericLiteral(value(prop(object, 'messageId')))))
      stop('exportWebhooksHistory.messageId is a string in v6; review the old numeric value.');
    if (name === 'program.getLpList' && (!object || prop(object, 'sort') && !Node.isStringLiteral(value(prop(object, 'sort')))))
      stop('GetLpListRequest.sort is an enum in v6; review the nonliteral value.');
    if (name === 'balance.createBalanceOrder' && (!object || prop(object, 'source') && !Node.isStringLiteral(value(prop(object, 'source')))))
      stop('CreateBalanceOrderRequest.source is an enum in v6; review the nonliteral value.');
    if (MESSAGE_METHODS.has(name) && (!object || !Node.isStringLiteral(value(prop(object, 'text')))))
      stop('Conversation message text is required as a string in v6; review this request.');
    if ((name === 'tier.deleteTierGroup' || name === 'tier.deleteTier') && sourceMajor(file) === 4 && consumed(call))
      stop(`The result of ${name} became void in v5; v4 callers must review this read.`);
    if (result.manual.length > manualBeforeCall) edits.splice(editsBeforeCall);
  }
  if (edits.length === 0) return;
  const before = file.getFullText();
  let after = before;
  for (const item of [...edits].sort((a, b) => b.start - a.start)) {
    after = after.slice(0, item.start) + item.replacement + after.slice(item.end);
    result.changes.push({ file: file.getFilePath(), line: item.line, rule: item.rule, before: item.before, after: item.replacement } satisfies Change);
  }
  if (after !== before) {
    result.fileUpdates!.push({ file: file.getFilePath(), contents: after });
    result.filesChanged.push(file.getFilePath());
  }
}

export const brevoV6: Migration = {
  id: '@getbrevo/brevo@6', packageName: PACKAGE, fromMajor: 5, additionalFromMajors: [4], toMajor: 6,
  releasedAt: '2026-10-17', title: 'Brevo SDK v4/v5 → v6',
  guideUrl: 'https://github.com/getbrevo/brevo-node', experimental: true,
  rules: ['batch-events-request', 'active-balance-request', 'companies-name-filter'],
  transform(project: Project): MigrationResult {
    const result: MigrationResult = { changes: [], manual: [], filesChanged: [], fileUpdates: [] };
    for (const file of project.getSourceFiles()) migrateFile(file, result);
    return result;
  },
  updateManifest(manifest: PackageManifest): string[] {
    const notes: string[] = [];
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      const current = manifest[field]?.[PACKAGE];
      if (!current) continue;
      if (/^\s*[~^]?[45](?:\.(?:\d+|x|\*)){0,2}\s*$/i.test(current)) {
        manifest[field]![PACKAGE] = '^6.2.0';
        notes.push(`\`${field}.${PACKAGE}\`: \`${current}\` → \`^6.2.0\``);
      } else notes.push(`Could not safely update \`${field}.${PACKAGE}\` from \`${current}\`; review the range manually.`);
    }
    return notes;
  },
};
