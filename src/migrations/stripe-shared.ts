import { Node, SyntaxKind, type Project, type SourceFile, type Symbol as MorphSymbol } from 'ts-morph';
import type { Change, ManualItem, MigrationResult } from '../core/types.js';

const PACKAGE = 'stripe';
const REQUEST_OPTION_KEYS = new Set([
  'apiKey', 'apiVersion', 'idempotencyKey', 'maxNetworkRetries', 'stripeAccount', 'timeout', 'host',
]);
const REMOVED_RESOURCE_METHODS = new Set([
  'createFullPath', 'createResourcePathWithSymbols', 'extend', 'method', '_joinUrlParts',
]);
// These exact signatures have an ID followed by optional params and options in
// stripe-node v22. The published v22 migration guide documents customers.retrieve;
// CustomersResource.update uses the same first three arguments. Other resources
// can have ID-less methods with the same name, so keep them manual until checked.
const ID_FIRST_REQUEST_METHODS = new Set(['customers.retrieve', 'customers.update']);
const PARAMS_FIRST_REQUEST_METHODS = new Set(['create', 'list', 'search']);
const STRIPE_RESOURCE_NAMES = new Set(['customers', 'products', 'accounts', 'paymentIntents', 'setupIntents', 'balance', 'invoices', 'charges', 'subscriptions', 'refunds', 'payouts', 'transfers', 'prices', 'checkout.sessions', 'billingPortal.sessions', 'paymentMethods', 'subscriptionItems', 'webhooks']);
const STRIPE_RESOURCE_METHODS = new Set(['create', 'retrieve', 'update', 'attach', 'detach', 'del', 'list', 'search', 'capture', 'confirm', 'cancel', 'pay', 'refund', 'send', 'verifyHeader', 'verifyHeaderAsync']);
// Removed from these parameter types in the published Stripe declarations.
// The destination SDK rejects the old field; replacing it can change payment behavior.
const REMOVED_PAYMENT_METHOD_TYPES_PARAMS = new Map([
  ['paymentIntents.create', 'PaymentIntentCreateParams'],
  ['paymentIntents.confirm', 'PaymentIntentConfirmParams'],
  ['paymentIntents.update', 'PaymentIntentUpdateParams'],
  ['setupIntents.create', 'SetupIntentCreateParams'],
  ['setupIntents.update', 'SetupIntentUpdateParams'],
]);

interface TextEdit {
  start: number;
  end: number;
  replacement: string;
  rule: string;
  before: string;
  line: number;
}

export function migrateStripeV22(project: Project): MigrationResult {
  const result = emptyResult();
  for (const sourceFile of project.getSourceFiles()) {
    const manualBefore = result.manual.length;
    const changesBefore = result.changes.length;
    migrateV22File(sourceFile, result);
    if (manualBefore === result.manual.length && changesBefore === result.changes.length
      && hasStripePackageReference(sourceFile) && findStripeBindings(sourceFile).constructors.size === 0) {
      addManual(sourceFile, result.manual, sourceFile, 'This file mentions Stripe without a recognized migration binding; inspect its SDK usage manually.', 'stripe');
    }
  }
  return result;
}

export function migrateStripeV23(project: Project): MigrationResult {
  const result = emptyResult();
  for (const sourceFile of project.getSourceFiles()) {
    const manualBefore = result.manual.length;
    const changesBefore = result.changes.length;
    migrateV23File(sourceFile, result);
    if (manualBefore === result.manual.length && changesBefore === result.changes.length
      && hasStripePackageReference(sourceFile) && findStripeBindings(sourceFile).constructors.size === 0) {
      addManual(sourceFile, result.manual, sourceFile, 'This file mentions Stripe without a recognized migration binding; inspect its SDK usage manually.', 'stripe');
    }
  }
  return result;
}

function emptyResult(): MigrationResult {
  return { changes: [], manual: [], filesChanged: [], fileUpdates: [] };
}

function migrateV22File(sourceFile: SourceFile, result: MigrationResult): void {
  if (withholdInvalidSource(sourceFile, result)) return;
  reportUnsupportedStripeImports(sourceFile, result);
  reportIndirectStripeClients(sourceFile, result, 22);
  const edits: TextEdit[] = [];
  const before = sourceFile.getFullText();
  const stripeBindings = findStripeBindings(sourceFile);
  const constructorNames = stripeBindings.constructors;

  for (const variable of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const name = variable.getNameNode();
    const initializer = variable.getInitializer();
    if (Node.isObjectBindingPattern(name) && initializer && Node.isPropertyAccessExpression(initializer)
      && initializer.getName() === 'default' && isRequireStripe(initializer.getExpression())) {
      addManual(sourceFile, result.manual, variable, 'Destructuring require("stripe").default is not rewritten automatically; inspect this import shape manually.', variable.getText());
    }
    if (!Node.isObjectBindingPattern(name) || !initializer || !isRequireStripe(initializer)) continue;
    const elements = name.getElements();
    const binding = elements[0];
    const sourceName = binding?.getPropertyNameNode()?.getText() ?? binding?.getNameNode().getText();
    if (elements.length !== 1 || !binding || !['Stripe', 'default'].includes(sourceName ?? '') || !Node.isIdentifier(binding.getNameNode())) {
      addManual(sourceFile, result.manual, variable, 'This destructured CommonJS Stripe import must be rewritten explicitly for v22.', redactedSnippet(variable.getText()));
      continue;
    }
    const alias = binding.getNameNode().getText();
    constructorNames.add(alias);
    const symbol = binding.getNameNode().getSymbol();
    if (symbol) stripeBindings.constructorSymbols.add(symbol);
    stripeBindings.typeNames.add(alias);
    edits.push(edit(sourceFile, name, alias, 'cjs-default-export', name.getText()));
  }

  const clients = findStripeClients(sourceFile, constructorNames);

  for (const property of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    if (!['default', 'Stripe'].includes(property.getName()) || !isRequireStripe(property.getExpression())) continue;
    if (property.getParentIfKind(SyntaxKind.CallExpression)?.getExpression() === property) continue;
    edits.push(edit(sourceFile, property, property.getExpression().getText(), 'cjs-default-export', property.getText()));
  }

  for (const typeReference of sourceFile.getDescendantsOfKind(SyntaxKind.TypeReference)) {
    const name = typeReference.getTypeName().getText();
    const prefix = [...stripeBindings.typeNames].find((binding) => name === `${binding}.StripeContext`);
    if (prefix) edits.push(edit(sourceFile, typeReference, `${prefix}.StripeContextType`, 'stripe-context-type', typeReference.getText()));
    const errorType = [...stripeBindings.typeNames]
      .map((binding) => name.startsWith(`${binding}.errors.`) ? name.slice(`${binding}.errors.`.length) : undefined)
      .find((candidate) => candidate && /^[A-Za-z_$][\w$]*$/.test(candidate));
    if (errorType) {
      const prefix = [...stripeBindings.typeNames].find((binding) => name.startsWith(`${binding}.errors.`))!;
      edits.push(edit(sourceFile, typeReference, `InstanceType<typeof ${prefix}.errors.${errorType}>`, 'stripe-error-type', typeReference.getText()));
    }
  }

  for (const directive of sourceFile.getTypeReferenceDirectives()) {
    if (directive.getFileName() !== 'stripe/types') continue;
    const directivePos = directive.getPos();
    const lineStart = before.lastIndexOf('\n', Math.max(0, directivePos - 1)) + 1;
    const newline = before.indexOf('\n', directivePos);
    const lineEnd = newline < 0 ? before.length : newline + 1;
    const line = before.slice(lineStart, newline < 0 ? before.length : newline).replace(/\r$/, '');
    if (!/^\s*\/\/\/\s*<reference\s+types=(['"])stripe\/types\1\s*\/>\s*$/.test(line)) continue;
    edits.push({
      start: lineStart,
      end: lineEnd,
      replacement: '',
      rule: 'remove-obsolete-type-reference',
      before: before.slice(lineStart, lineEnd),
      line: sourceFile.getLineAndColumnAtPos(lineStart).line,
    });
  }

  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expression = call.getExpression();
    if (expression.getText().startsWith('this.stripe.')
      && call.getArguments().some((argument) => Node.isArrowFunction(argument) || Node.isFunctionExpression(argument))) {
      addManual(sourceFile, result.manual, call, 'Stripe v22 removes callbacks from client methods reached through this.stripe; convert this call manually to promises.', call.getText());
    }
    const [root, ...path] = propertyPath(expression);
    if (root && clients.has(root) && path.length >= 2) {
      const args = call.getArguments();
      const functionArg = args.find((argument) => Node.isArrowFunction(argument) || Node.isFunctionExpression(argument));
      if (functionArg) {
        addManual(sourceFile, result.manual, functionArg, 'Stripe v22 removes callbacks from API service methods. Convert this callback flow to promises/async code and make the containing function async if appropriate.', redactedSnippet(call.getText()));
      }

      const hostArgument = args.find((argument) => Node.isObjectLiteralExpression(argument) && argument.getProperties().some((prop) => Node.isPropertyAssignment(prop) && prop.getName() === 'host'));
      if (hostArgument) {
        addManual(sourceFile, result.manual, hostArgument, 'Stripe v22 removes per-request host overrides. Move the host to the Stripe client configuration after checking that all calls on this client should use it.', redactedSnippet(call.getText()));
      }

      const removedMethod = path.at(-1);
      if (removedMethod && REMOVED_RESOURCE_METHODS.has(removedMethod)) {
        addManual(sourceFile, result.manual, call, `Stripe v22 removes StripeResource.${removedMethod}; there is no safe automatic replacement.`, redactedSnippet(call.getText()));
      }

      // The v22 signature `(id, params?, options?)` needs an explicit params slot
      // only for known ID-first methods called as `(id, options)`. In particular,
      // create/list take `(params?, options?)` and must never gain an `undefined`.
      const method = path.at(-1);
      const resourceMethod = path.join('.');
      const optionCandidate = args.length === 2 ? args[1] : undefined;
      if (!hostArgument && optionCandidate && Node.isIdentifier(optionCandidate)
        && ID_FIRST_REQUEST_METHODS.has(resourceMethod)) {
        addManual(sourceFile, result.manual, call, 'Variable request options may need a different v22 argument position; inspect the referenced value and method signature manually.', redactedSnippet(call.getText()));
      }
      if (!hostArgument && method && ID_FIRST_REQUEST_METHODS.has(resourceMethod) && args.length === 2
        && isResourceIdArgument(args[0]!) && optionCandidate && isRequestOptionsObject(optionCandidate)) {
        edits.push(edit(sourceFile, optionCandidate, `undefined, ${optionCandidate.getText()}`, 'request-options-position', optionCandidate.getText()));
      } else if (!hostArgument && method && args.length === 2
        && ((optionCandidate && containsRequestOptionKey(optionCandidate)
          && !PARAMS_FIRST_REQUEST_METHODS.has(method)
          && (!ID_FIRST_REQUEST_METHODS.has(resourceMethod) || !isResourceIdArgument(args[0]!) || !isRequestOptionsObject(optionCandidate)))
          || (PARAMS_FIRST_REQUEST_METHODS.has(method) && containsRequestOptionKey(args[0]!)))) {
        addManual(sourceFile, result.manual, call, 'The Stripe request arguments resemble RequestOptions, but their v22 parameter position is ambiguous. Verify this method’s `(id, params?, options?)` or `(params?, options?)` signature and move options manually; no arguments were changed.', redactedSnippet(call.getText()));
      } else if (!hostArgument && method && args.length === 1 && containsRequestOptionKey(args[0]!)) {
        addManual(sourceFile, result.manual, call, 'This Stripe argument may be RequestOptions rather than resource parameters. Confirm the v22 RequestOptions position manually; no arguments were changed.', redactedSnippet(call.getText()));
      }

      const stringApiKey = args.find((argument, index) => index > 0 && isStripeSecretLiteral(argument));
      if (stringApiKey) {
        addManual(sourceFile, result.manual, stringApiKey, 'Stripe v22 no longer accepts a string API key as a service-method argument. Put it in a RequestOptions object under apiKey; the key value is redacted here.', '[API key redacted]');
      }
    }
  }

  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expression = call.getExpression();
    if (Node.isIdentifier(expression) && constructorNames.has(expression.getText())
      && stripeBindings.constructorSymbols.has(expression.getSymbol()!)) {
      const parent = call.getParent();
      if (Node.isNewExpression(parent) && parent.getExpression() === expression) continue;
      edits.push(edit(sourceFile, expression, `new ${expression.getText()}`, 'stripe-constructor', expression.getText()));
      continue;
    }
    if (Node.isPropertyAccessExpression(expression)
      && ['default', 'Stripe'].includes(expression.getName())
      && isRequireStripe(expression.getExpression())) {
      edits.push(edit(sourceFile, expression, `new (${expression.getExpression().getText()})`, 'stripe-constructor', expression.getText()));
      continue;
    }
    if (isRequireStripe(expression)) {
      edits.push(edit(sourceFile, expression, `new (${expression.getText()})`, 'stripe-constructor', expression.getText()));
    }
  }

  applyStripeEdits(sourceFile, edits, result, before);
}

function migrateV23File(sourceFile: SourceFile, result: MigrationResult): void {
  if (withholdInvalidSource(sourceFile, result)) return;
  reportUnsupportedStripeImports(sourceFile, result);
  reportIndirectStripeClients(sourceFile, result, 23);
  const edits: TextEdit[] = [];
  const before = sourceFile.getFullText();
  const stripeBindings = findStripeBindings(sourceFile);
  const clients = findStripeClients(sourceFile, stripeBindings.constructors);
  // Many projects export the client from a separate module, as signet does.
  // A type/value import from stripe in this file anchors the inferred client.
  if (stripeBindings.typeNames.size > 0) {
    for (const declaration of sourceFile.getImportDeclarations()) {
      if (!declaration.getModuleSpecifierValue().startsWith('.')) continue;
      for (const specifier of declaration.getNamedImports()) {
        if (specifier.getName() === 'stripe') clients.add(specifier.getAliasNode()?.getText() ?? specifier.getName());
      }
    }
  }

  for (const typeReference of sourceFile.getDescendantsOfKind(SyntaxKind.TypeReference)) {
    const name = typeReference.getTypeName().getText();
    for (const binding of stripeBindings.typeNames) {
      if (name === `${binding}.ErrorType` || name.startsWith(`${binding}.ErrorType.`)) {
        edits.push(edit(sourceFile, typeReference, name.replace(`${binding}.ErrorType`, `${binding}.errors`), 'error-type-namespace', typeReference.getText()));
        break;
      }
      if (name === `${binding}.AddressParam` || name === `${binding}.JapanAddressParam`) {
        addManual(sourceFile, result.manual, typeReference, 'Stripe v23 uses operation-specific address types for V2 requests. Choose the type from the specific operation; this shared type may still be valid for V1.', typeReference.getText());
        break;
      }
    }
  }

  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expression = call.getExpression();
    const path = propertyPath(expression);
    const [root] = path;
    if (!root || !clients.has(root)) continue;
    const method = path.at(-1);
    const parameterType = REMOVED_PAYMENT_METHOD_TYPES_PARAMS.get(`${path[1]}.${method}`);
    if (path.length === 3 && parameterType) {
      const params = call.getArguments()[method === 'create' ? 0 : 1];
      if (params && Node.isObjectLiteralExpression(params)) {
        const removed = params.getProperties().find((property) =>
          (Node.isPropertyAssignment(property) || Node.isShorthandPropertyAssignment(property))
          && property.getName() === 'payment_method_types');
        if (removed) addManual(sourceFile, result.manual, removed,
          `Stripe v23 no longer accepts payment_method_types in ${parameterType}. Review the intended payment methods against the new API before changing this payment flow; no replacement was made.`,
          redactedSnippet(removed.getText()));
      }
    }
    if (method === 'constructEventWithoutVerification' && path.length === 2) {
      const receiver = Node.isPropertyAccessExpression(expression) ? expression.getExpression() : undefined;
      if (receiver) edits.push(edit(sourceFile, expression, `${receiver.getText()}.webhooks.constructEventWithoutVerification`, 'webhook-method-location', expression.getText()));
    }
    if (method === 'verifyHeader' || method === 'verifyHeaderAsync') {
      if (call.getArguments().length < 4) {
        addManual(sourceFile, result.manual, call, 'Stripe v23 now applies DEFAULT_TOLERANCE to webhook signature timestamp checks. Confirm this default is intended, or pass 0 explicitly only if the old no-tolerance behavior is required.', redactedSnippet(call.getText()));
      }
    }
  }

  // The v23 SDK changes its default and pinned API version. Review missing, dynamic,
  // or older explicit versions because SDK type declarations are pinned to v23's API.
  for (const creation of sourceFile.getDescendantsOfKind(SyntaxKind.NewExpression)) {
    const expression = creation.getExpression();
    if (!isStripeConstructor(expression, stripeBindings.constructors)) continue;
    const options = creation.getArguments()?.[1];
    const apiVersionProperty = Node.isObjectLiteralExpression(options)
      ? options.getProperties().find((property) => Node.isPropertyAssignment(property) && property.getName() === 'apiVersion')
      : undefined;
    const versionExpression = apiVersionProperty && Node.isPropertyAssignment(apiVersionProperty)
      ? apiVersionProperty.getInitializer()
      : undefined;
    const apiVersion = versionExpression && Node.isStringLiteral(versionExpression)
      ? versionExpression.getLiteralValue()
      : undefined;
    if (apiVersion !== '2026-09-30.endive') {
      const reason = apiVersion
        ? `Stripe v23 is pinned to API version 2026-09-30.endive, while this client explicitly uses ${apiVersion}. Review the Stripe API changelog and update/test the pinned version before upgrading.`
        : 'Stripe v23 changes the default API version to 2026-09-30.endive. Review Stripe’s API changelog and test behavior, or pin an explicit apiVersion before upgrading.';
      addManual(sourceFile, result.manual, creation, reason, redactedSnippet(creation.getText()));
    }
  }

  applyStripeEdits(sourceFile, edits, result, before);
}

function reportUnsupportedStripeImports(sourceFile: SourceFile, result: MigrationResult): void {
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (call.getExpression().getText() !== 'require') continue;
    const argument = call.getArguments()[0];
    if (Node.isNoSubstitutionTemplateLiteral(argument) && argument.getLiteralValue() === PACKAGE) {
      addManual(sourceFile, result.manual, call, 'A backtick Stripe require needs manual review before upgrading.', 'require(`stripe`)');
    }
  }
  for (const declaration of sourceFile.getImportDeclarations()) {
    if (declaration.getModuleSpecifierValue() !== PACKAGE) continue;
    if (declaration.getNamespaceImport()) {
      addManual(sourceFile, result.manual, declaration, 'A namespace Stripe import needs manual review before this migration.', declaration.getText());
    }
    if (declaration.getNamedImports().some((specifier) => specifier.getName() === 'default')) {
      addManual(sourceFile, result.manual, declaration, 'A named default Stripe import needs manual review before this migration.', declaration.getText());
    }
  }
}

function hasStripePackageReference(sourceFile: SourceFile): boolean {
  if (sourceFile.getImportDeclarations().some((declaration) => declaration.getModuleSpecifierValue() === PACKAGE)) return true;
  if (sourceFile.getDescendantsOfKind(SyntaxKind.ImportEqualsDeclaration).some((declaration) => declaration.getText().includes("'stripe'") || declaration.getText().includes('"stripe"'))) return true;
  return sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).some((call) => {
    const argument = call.getArguments()[0];
    return ['require', 'import'].includes(call.getExpression().getText())
      && (Node.isStringLiteral(argument) || Node.isNoSubstitutionTemplateLiteral(argument))
      && argument.getLiteralValue() === PACKAGE;
  });
}

function reportIndirectStripeClients(sourceFile: SourceFile, result: MigrationResult, targetMajor: 22 | 23): void {
  const bindings = findStripeBindings(sourceFile);
  const trackedClients = findStripeClients(sourceFile, bindings.constructors);
  const indirectAliases = new Set<string>();
  for (const declaration of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const initializer = declaration.getInitializer();
    if (!initializer || !Node.isIdentifier(initializer)
      || (!trackedClients.has(initializer.getText()) && !bindings.constructors.has(initializer.getText()))) continue;
    const name = declaration.getNameNode();
    if (Node.isIdentifier(name)) indirectAliases.add(name.getText());
    else if (Node.isObjectBindingPattern(name)) for (const element of name.getElements()) indirectAliases.add(element.getNameNode().getText());
    addManual(sourceFile, result.manual, declaration, 'A Stripe client or constructor alias is untracked; review all uses before upgrading.', declaration.getText());
  }
  const typedParameters = new Set(sourceFile.getDescendantsOfKind(SyntaxKind.Parameter)
    .filter((parameter) => /\bStripe\b/.test(parameter.getTypeNode()?.getText() ?? ''))
    .map((parameter) => parameter.getName()));
  const locallyImported = new Set(sourceFile.getImportDeclarations()
    .filter((declaration) => declaration.getModuleSpecifierValue().startsWith('.'))
    .flatMap((declaration) => [
      ...(declaration.getDefaultImport() ? [declaration.getDefaultImport()!.getText()] : []),
      ...declaration.getNamedImports().map((specifier) => specifier.getAliasNode()?.getText() ?? specifier.getName()),
    ]));
  // A resource-shaped call in an unrelated file (database, CRM, etc.) is not
  // evidence of Stripe. Local imports named stripe still cover the common
  // separate-client-module pattern without requiring that module to import
  // the SDK in this same file.
  const importedStripeModule = sourceFile.getImportDeclarations().some((declaration) =>
    declaration.getModuleSpecifierValue().startsWith('.')
    && Boolean(declaration.getModuleSpecifierSourceFile()
      && hasStripePackageReference(declaration.getModuleSpecifierSourceFile()!)));
  if (!hasStripePackageReference(sourceFile) && ![...locallyImported].some((name) => /stripe/i.test(name))
    && !importedStripeModule) return;
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expression = call.getExpression();
    const path = propertyPath(expression);
    const text = expression.getText();
    const normalized = text.replace(/\[['"]([A-Za-z][A-Za-z0-9]*)['"]\]/g, '.$1');
    const parts = normalized.split('.');
    const resourceUse = parts.length >= 3 && STRIPE_RESOURCE_METHODS.has(parts.at(-1)!)
      && (STRIPE_RESOURCE_NAMES.has(parts.at(-2)!)
        || STRIPE_RESOURCE_NAMES.has(`${parts.at(-3)}.${parts.at(-2)}`));
    const root = parts[0] ?? '';
    const requestOptions = call.getArguments().some((argument) => hasRequestOptionEvidence(sourceFile, argument));
    const method = parts.at(-1) ?? '';
    const affectedCall = requestOptions || call.getArguments().some((argument) =>
      Node.isArrowFunction(argument) || Node.isFunctionExpression(argument) || isStripeSecretLiteral(argument))
      || REMOVED_RESOURCE_METHODS.has(method)
      || (targetMajor === 23 && ['constructEvent', 'constructEventAsync'].includes(method));
    const indirect = resourceUse && (affectedCall || root === 'c' && bindings.constructors.size > 0) && (
      text.startsWith('this.stripe.')
      || (text.startsWith('this.client.') && requestOptions)
      || typedParameters.has(root)
      || (locallyImported.has(root) && (requestOptions || /stripe/i.test(root)))
      || indirectAliases.has(path[0] ?? '')
      || (root === 'c' && bindings.constructors.size > 0)
    ) || indirectAliases.has(path[0] ?? '') && parts.length <= 2;
    if (!indirect || result.manual.some((item) => item.file === sourceFile.getFilePath() && item.line === call.getStartLineNumber())) continue;
    addManual(sourceFile, result.manual, call, 'This indirectly held Stripe client is untracked; review its v22/v23 request behavior manually.', call.getText());
  }
}

function hasRequestOptionEvidence(sourceFile: SourceFile, argument: Node): boolean {
  if (containsRequestOptionKey(argument)) return true;
  if (!Node.isIdentifier(argument)) return false;
  return sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration).some((declaration) =>
    declaration.getName() === argument.getText()
    && Boolean(declaration.getInitializer() && containsRequestOptionKey(declaration.getInitializer()!)));
}

function findStripeBindings(sourceFile: SourceFile): { constructors: Set<string>; typeNames: Set<string>; constructorSymbols: Set<MorphSymbol> } {
  const constructors = new Set<string>();
  const typeNames = new Set<string>();
  const constructorSymbols = new Set<MorphSymbol>();
  for (const declaration of sourceFile.getImportDeclarations()) {
    if (declaration.getModuleSpecifierValue() !== PACKAGE) continue;
    const defaultImport = declaration.getDefaultImport();
    if (defaultImport) {
      constructors.add(defaultImport.getText());
      typeNames.add(defaultImport.getText());
      const symbol = defaultImport.getSymbol();
      if (symbol) constructorSymbols.add(symbol);
    }
    for (const specifier of declaration.getNamedImports()) {
      if (specifier.getName() !== 'Stripe') continue;
      const localName = specifier.getAliasNode()?.getText() ?? specifier.getName();
      constructors.add(localName);
      typeNames.add(localName);
      const symbol = (specifier.getAliasNode() ?? specifier.getNameNode()).getSymbol();
      if (symbol) constructorSymbols.add(symbol);
    }
  }
  for (const declaration of sourceFile.getDescendantsOfKind(SyntaxKind.ImportEqualsDeclaration)) {
    const reference = declaration.getModuleReference();
    const expression = Node.isExternalModuleReference(reference) ? reference.getExpression() : undefined;
    if (expression && Node.isStringLiteral(expression) && expression.getLiteralValue() === PACKAGE) {
      constructors.add(declaration.getName());
      typeNames.add(declaration.getName());
      const symbol = declaration.getNameNode().getSymbol();
      if (symbol) constructorSymbols.add(symbol);
    }
  }
  for (const declaration of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const name = declaration.getNameNode();
    const initializer = declaration.getInitializer();
    if (!Node.isIdentifier(name) || !initializer) continue;
    if (isRequireStripe(initializer) || (Node.isPropertyAccessExpression(initializer)
      && ['default', 'Stripe'].includes(initializer.getName()) && isRequireStripe(initializer.getExpression()))) {
      constructors.add(name.getText());
      typeNames.add(name.getText());
      const symbol = name.getSymbol();
      if (symbol) constructorSymbols.add(symbol);
    }
  }
  return { constructors, typeNames, constructorSymbols };
}

function findStripeClients(sourceFile: SourceFile, constructors: Set<string>): Set<string> {
  const clients = new Set<string>();
  for (const declaration of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const name = declaration.getNameNode();
    const initializer = declaration.getInitializer();
    if (!Node.isIdentifier(name) || !initializer) continue;
    if (Node.isNewExpression(initializer) && isStripeConstructor(initializer.getExpression(), constructors)) {
      clients.add(name.getText());
    } else if (Node.isCallExpression(initializer)) {
      const expression = initializer.getExpression();
      if ((Node.isIdentifier(expression) && constructors.has(expression.getText())) || isRequireStripe(expression)
        || (Node.isPropertyAccessExpression(expression) && ['default', 'Stripe'].includes(expression.getName()) && isRequireStripe(expression.getExpression()))) {
        clients.add(name.getText());
      }
    }
  }
  return clients;
}

function isStripeConstructor(node: Node, constructors: Set<string>): boolean {
  if (Node.isIdentifier(node)) return constructors.has(node.getText());
  if (Node.isCallExpression(node)) return isRequireStripe(node);
  if (Node.isParenthesizedExpression(node)) return isStripeConstructor(node.getExpression(), constructors);
  return false;
}

function isRequireStripe(node: Node): boolean {
  if (!Node.isCallExpression(node) || !Node.isIdentifier(node.getExpression()) || node.getExpression().getText() !== 'require') return false;
  const argument = node.getArguments()[0];
  if (!argument || !Node.isStringLiteral(argument)) return false;
  return argument.getLiteralValue() === PACKAGE;
}

function propertyPath(node: Node): string[] {
  if (Node.isIdentifier(node)) return [node.getText()];
  if (Node.isPropertyAccessExpression(node)) return [...propertyPath(node.getExpression()), node.getName()];
  return [];
}

function isRequestOptionsObject(node: Node): boolean {
  if (!Node.isObjectLiteralExpression(node) || node.getProperties().length === 0) return false;
  return node.getProperties().every((property) => Node.isPropertyAssignment(property) && REQUEST_OPTION_KEYS.has(property.getName()));
}

function containsRequestOptionKey(node: Node): boolean {
  return Node.isObjectLiteralExpression(node)
    && node.getProperties().some((property) => Node.isPropertyAssignment(property) && REQUEST_OPTION_KEYS.has(property.getName()));
}

function isResourceIdArgument(node: Node): boolean {
  return Node.isStringLiteral(node)
    || Node.isNoSubstitutionTemplateLiteral(node)
    || (Node.isIdentifier(node) && node.getText() !== 'undefined')
    || Node.isPropertyAccessExpression(node)
    || Node.isElementAccessExpression(node);
}

function isStripeSecretLiteral(node: Node): boolean {
  if (!Node.isStringLiteral(node) && !Node.isNoSubstitutionTemplateLiteral(node)) return false;
  return /^sk_(?:test|live)_/.test(node.getLiteralValue());
}

function edit(sourceFile: SourceFile, node: Node, replacement: string, rule: string, before: string): TextEdit {
  return {
    start: node.getStart(),
    end: node.getEnd(),
    replacement,
    rule,
    before,
    line: sourceFile.getLineAndColumnAtPos(node.getStart()).line,
  };
}

export function applyStripeEdits(sourceFile: SourceFile, edits: TextEdit[], result: MigrationResult, original: string): void {
  if (edits.length === 0) return;
  const unique = new Map<string, TextEdit>();
  for (const change of edits) {
    const key = `${change.start}:${change.end}`;
    const previous = unique.get(key);
    if (previous && previous.replacement !== change.replacement) {
      reportOverlap(sourceFile, result, change);
      return;
    }
    unique.set(key, change);
  }
  const ordered = [...unique.values()].sort((left, right) => right.start - left.start || right.end - left.end);
  let boundary = original.length + 1;
  for (const change of ordered) {
    if (change.end > boundary) {
      reportOverlap(sourceFile, result, change);
      return;
    }
    boundary = change.start;
  }
  let migrated = original;
  for (const change of ordered) {
    migrated = migrated.slice(0, change.start) + change.replacement + migrated.slice(change.end);
    const after = change.rule === 'request-options-position'
      ? `undefined, ${change.before}`
      : change.replacement;
    result.changes.push({ file: sourceFile.getFilePath(), line: change.line, rule: change.rule, before: change.before, after });
  }
  if (migrated === original) return;
  result.filesChanged.push(sourceFile.getFilePath());
  result.fileUpdates?.push({ file: sourceFile.getFilePath(), contents: migrated });
}

function withholdInvalidSource(sourceFile: SourceFile, result: MigrationResult): boolean {
  const diagnostics = (sourceFile.compilerNode as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [];
  if (diagnostics.length === 0) return false;
  const isStripeSpecifier = (value: string): boolean => value === PACKAGE || value.startsWith(`${PACKAGE}/`);
  const hasImport = sourceFile.getImportDeclarations().some((declaration) => isStripeSpecifier(declaration.getModuleSpecifierValue()));
  const hasRequire = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).some((call) => {
    const expression = call.getExpression();
    if (!(Node.isIdentifier(expression) && expression.getText() === 'require') && expression.getKind() !== SyntaxKind.ImportKeyword) return false;
    const argument = call.getArguments()[0];
    return Node.isStringLiteral(argument) && isStripeSpecifier(argument.getLiteralValue());
  });
  if (!hasImport && !hasRequire) return true;
  result.manual.push({
    file: sourceFile.getFilePath(), line: 1,
    reason: `This Stripe source file has ${diagnostics.length} syntax error(s); automatic edits were withheld until the file parses cleanly.`,
    snippet: redactedSnippet(sourceFile.getFullText().split(/\r?\n/, 1)[0] ?? ''),
  });
  return true;
}

function reportOverlap(sourceFile: SourceFile, result: MigrationResult, change: TextEdit): void {
  result.manual.push({
    file: sourceFile.getFilePath(), line: change.line,
    reason: 'Two Stripe migration edits overlap; automatic edits for this file were withheld for manual review.',
    snippet: redactedSnippet(change.before),
  });
}

function addManual(sourceFile: SourceFile, findings: ManualItem[], node: Node, reason: string, snippet: string): void {
  if (findings.some((finding) => finding.file === sourceFile.getFilePath() && finding.line === node.getStartLineNumber() && finding.reason === reason)) return;
  findings.push({ file: sourceFile.getFilePath(), line: node.getStartLineNumber(), reason, snippet: redactedSnippet(snippet) });
}

function redactedSnippet(value: string): string {
  return value.replace(/(['"`])sk_(?:test|live)_[A-Za-z0-9]+\1/g, '$1[REDACTED_STRIPE_KEY]$1');
}
