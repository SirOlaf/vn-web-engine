#!/usr/bin/env node
/** Read-only native-slot accounting. Runtime source is parsed, never imported or executed. */
import {createHash} from 'node:crypto';
import {lstat, readFile, readdir, realpath, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {API} from 'typescript/unstable/sync';
import {createVirtualFileSystem} from 'typescript/unstable/fs';
import * as ts from 'typescript/unstable/ast';

const UNKNOWN = Symbol('unresolved syntax');
const OPAQUE = Symbol('unevaluated handler');
const PROJECTION = Symbol('literal metadata helper');
const HEX = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;
const HASH = /^[0-9a-f]{64}$/;
const SLOT = /^[0-9a-f]{2}:[0-9a-f]{2}$/;
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const hex = (value) => `0x${BigInt(value).toString(16)}`;
const slotId = (primary, secondary) =>
  `${Number(primary).toString(16).padStart(2, '0')}:${Number(secondary).toString(16).padStart(2, '0')}`;
const sort = (values) => [...values].sort();
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const inRoot = (file, root) => file === root || file.startsWith(`${root}/`);

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

function localPath(root, file) {
  requireThat(
    typeof file === 'string' && file.length > 0 && !path.isAbsolute(file),
    `Invalid relative path: ${file}`,
  );
  const resolved = path.resolve(root, file);
  requireThat(
    resolved.startsWith(`${path.resolve(root)}${path.sep}`),
    `Path escapes repository: ${file}`,
  );
  return resolved;
}

/** TS7's parser lives in its native API. All files/config are virtual; no emit or type checking. */
export function parseSources(files) {
  const base = '/native-slot-audit';
  const virtual = Object.fromEntries(
    Object.entries(files).map(([name, text]) => [`${base}/${name}`, text]),
  );
  virtual[`${base}/tsconfig.json`] = JSON.stringify({
    compilerOptions: {noLib: true, noResolve: true, allowJs: true, checkJs: false, types: []},
    files: Object.keys(files),
  });
  const api = new API({cwd: base, fs: createVirtualFileSystem(virtual)});
  try {
    const snapshot = api.updateSnapshot({openProjects: [`${base}/tsconfig.json`]});
    const program = snapshot.getProject(`${base}/tsconfig.json`).program;
    const diagnostics = program.getSyntacticDiagnostics();
    requireThat(
      diagnostics.length === 0,
      `Source syntax errors prevent slot audit: ${JSON.stringify(diagnostics)}`,
    );
    const parsed = new Map(
      Object.keys(files).map((file) => [file, program.getSourceFile(`${base}/${file}`)]),
    );
    for (const [file, source] of parsed) requireThat(source, `Parser omitted ${file}`);
    snapshot.dispose();
    return parsed;
  } finally {
    api.close();
  }
}

function unwrap(node) {
  while (
    node &&
    (ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertion(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node))
  )
    node = node.expression;
  return node;
}

function nameOf(node) {
  if (!node) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node))
    return node.text;
  return undefined;
}

function walk(node, visit) {
  visit(node);
  node.forEachChild((child) => {
    walk(child, visit);
  });
}

function bind(pattern, value, env) {
  if (ts.isIdentifier(pattern)) env.set(pattern.text, value);
  else if (ts.isArrayBindingPattern(pattern) && Array.isArray(value)) {
    pattern.elements.forEach((element, index) => {
      if (ts.isBindingElement(element) && !element.dotDotDotToken && !element.initializer)
        bind(element.name, value[index] ?? UNKNOWN, env);
    });
  }
}

/** A deliberately bounded AST projection, not a JavaScript evaluator. Unknown syntax stays unknown. */
function literal(node, env = new Map(), depth = 0) {
  if (!node || depth > 64) return UNKNOWN;
  node = unwrap(node);
  const read = (child, scope = env) => literal(child, scope, depth + 1);
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isBigIntLiteral(node)) return BigInt(node.text.replace(/n$/, ''));
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) return env.get(node.text) ?? UNKNOWN;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const body = unwrap(node.body);
    return body && (ts.isObjectLiteralExpression(body) || ts.isArrayLiteralExpression(body))
      ? {[PROJECTION]: node}
      : OPAQUE;
  }
  if (ts.isArrayLiteralExpression(node)) {
    const values = [];
    for (const item of node.elements) {
      if (ts.isSpreadElement(item)) {
        const spread = read(item.expression);
        if (!Array.isArray(spread)) return UNKNOWN;
        values.push(...spread);
      } else values.push(read(item));
    }
    return values;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const result = Object.create(null);
    for (const property of node.properties) {
      const name = nameOf(property.name);
      if (name === undefined || Object.hasOwn(result, name)) return UNKNOWN;
      if (ts.isPropertyAssignment(property))
        result[name] = name === 'execute' ? OPAQUE : read(property.initializer);
      else if (ts.isShorthandPropertyAssignment(property))
        result[name] = name === 'execute' ? OPAQUE : (env.get(name) ?? UNKNOWN);
      else return UNKNOWN;
    }
    return result;
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'map' &&
    node.arguments.length === 1
  ) {
    const input = read(node.expression.expression),
      callback = unwrap(node.arguments[0]);
    if (
      !Array.isArray(input) ||
      !ts.isArrowFunction(callback) ||
      ts.isBlock(callback.body) ||
      callback.parameters.length !== 1
    )
      return UNKNOWN;
    return input.map((value) => {
      const scope = new Map(env);
      bind(callback.parameters[0].name, value, scope);
      return read(callback.body, scope);
    });
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    const helper = env.get(node.expression.text)?.[PROJECTION];
    if (helper && node.arguments.length === helper.parameters.length) {
      const scope = new Map(env);
      helper.parameters.forEach((parameter, index) =>
        bind(parameter.name, read(node.arguments[index]), scope),
      );
      return read(helper.body, scope);
    }
  }
  return UNKNOWN;
}

function variables(statements, env) {
  for (const statement of statements)
    if (ts.isVariableStatement(statement)) {
      // Only const bindings are eligible; assignments and arbitrary expressions are never followed.
      if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
      for (const declaration of statement.declarationList.declarations)
        bind(declaration.name, literal(declaration.initializer, env), env);
    }
}

export function extractInventory(source, exportName, imageBase) {
  let initializer;
  for (const statement of source.statements)
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations)
        if (nameOf(declaration.name) === exportName) {
          requireThat(!initializer, `Duplicate inventory ${exportName}`);
          initializer = declaration.initializer;
        }
    }
  requireThat(initializer, `Missing inventory ${exportName}`);
  const table = literal(initializer);
  requireThat(
    table !== UNKNOWN && table && !Array.isArray(table),
    'Inventory must be a literal bank/slot/address object',
  );
  const rows = [],
    banks = [];
  for (const [primaryText, entries] of Object.entries(table)) {
    const primary = Number(primaryText);
    requireThat(
      Number.isInteger(primary) &&
        primary >= 0 &&
        primary <= 255 &&
        entries !== UNKNOWN &&
        entries &&
        !Array.isArray(entries),
      `Invalid bank ${primaryText}`,
    );
    const bytes = Buffer.alloc(256 * 8);
    for (const [secondaryText, address] of Object.entries(entries)) {
      const secondary = Number(secondaryText);
      requireThat(
        Number.isInteger(secondary) &&
          secondary >= 0 &&
          secondary <= 255 &&
          Number.isSafeInteger(address) &&
          BigInt(address) >= BigInt(imageBase),
        `Invalid inventory entry ${primaryText}:${secondaryText}`,
      );
      bytes.writeBigUInt64LE(BigInt(address), secondary * 8);
      rows.push({id: slotId(primary, secondary), rva: hex(BigInt(address) - BigInt(imageBase))});
    }
    banks.push({
      id: primary.toString(16).padStart(2, '0'),
      count: Object.keys(entries).length,
      tableSha256: sha256(bytes),
    });
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  banks.sort((a, b) => a.id.localeCompare(b.id));
  return {rows, banks, canonicalSha256: sha256(JSON.stringify(rows))};
}

function providerType(type, typeName) {
  if (type && ts.isTypeOperatorNode(type) && type.operator === ts.SyntaxKind.ReadonlyKeyword)
    type = type.type;
  if (
    type &&
    ts.isArrayTypeNode(type) &&
    ts.isTypeReferenceNode(type.elementType) &&
    nameOf(type.elementType.typeName) === typeName
  )
    return 'array';
  if (type && ts.isTypeReferenceNode(type) && nameOf(type.typeName) === typeName) return 'slot';
  return null;
}

function lineOf(source, node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function providerRecord(file, source, declaration, kind, outputs, unresolved, text, imageBase) {
  const entries = [];
  for (const value of outputs) {
    if (
      value === UNKNOWN ||
      !value ||
      !Number.isInteger(value.primary) ||
      value.primary < 0 ||
      value.primary > 255 ||
      !Number.isInteger(value.secondary) ||
      value.secondary < 0 ||
      value.secondary > 255 ||
      !Number.isSafeInteger(value.nativeAddress) ||
      BigInt(value.nativeAddress) < BigInt(imageBase) ||
      value.execute !== OPAQUE
    ) {
      unresolved.push({
        line: lineOf(source, declaration),
        reason: 'Unresolved returned slot metadata',
      });
      continue;
    }
    entries.push({
      slot: slotId(value.primary, value.secondary),
      rva: hex(BigInt(value.nativeAddress) - BigInt(imageBase)),
      name: typeof value.name === 'string' ? value.name : null,
    });
  }
  entries.sort((a, b) => a.slot.localeCompare(b.slot));
  return {
    id: `${file}#${declaration.name.text}`,
    kind,
    file,
    export: declaration.name.text,
    line: lineOf(source, declaration),
    sha256: sha256(text),
    entries,
    unresolved,
    references: [],
  };
}

/** Metadata is projected only from a returned literal/tuple map or a single local push helper. */
export function discoverFactories(parsed, files, config, imageBase) {
  const factories = [];
  for (const [file, source] of parsed) {
    if (!config.definitionRoots.some((root) => inRoot(file, root))) continue;
    const globals = new Map();
    variables(source.statements, globals);
    for (const declaration of source.statements) {
      if (
        ts.isVariableStatement(declaration) &&
        declaration.declarationList.flags & ts.NodeFlags.Const &&
        declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        for (const variable of declaration.declarationList.declarations) {
          const type = providerType(variable.type, config.slotType);
          if (!type || !ts.isIdentifier(variable.name)) continue;
          const value = literal(variable.initializer, globals);
          const outputs = type === 'slot' ? [value] : Array.isArray(value) ? value : [UNKNOWN];
          factories.push(
            providerRecord(
              file,
              source,
              variable,
              `constant-${type}`,
              outputs,
              [],
              files[file],
              imageBase,
            ),
          );
        }
        continue;
      }
      if (
        !ts.isFunctionDeclaration(declaration) ||
        !declaration.name ||
        !declaration.body ||
        providerType(declaration.type, config.slotType) !== 'array'
      )
        continue;
      if (!declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
        continue;
      const env = new Map(globals),
        helpers = new Map(),
        outputs = [],
        unresolved = [];
      // Bind in declaration order below. The projection never enters execute bodies.
      for (const statement of declaration.body.statements) {
        if (ts.isVariableStatement(statement)) {
          variables([statement], env);
          for (const variable of statement.declarationList.declarations) {
            const value = unwrap(variable.initializer);
            if (
              !nameOf(variable.name) ||
              !value ||
              !ts.isArrowFunction(value) ||
              !ts.isBlock(value.body) ||
              value.body.statements.length !== 1
            )
              continue;
            const only = value.body.statements[0];
            const call = ts.isExpressionStatement(only) ? only.expression : undefined;
            if (
              !call ||
              !ts.isCallExpression(call) ||
              !ts.isPropertyAccessExpression(call.expression) ||
              call.expression.name.text !== 'push' ||
              !ts.isIdentifier(call.expression.expression) ||
              call.arguments.length !== 1 ||
              !ts.isObjectLiteralExpression(call.arguments[0])
            )
              continue;
            helpers.set(nameOf(variable.name), {
              target: call.expression.expression.text,
              parameters: value.parameters,
              template: call.arguments[0],
            });
          }
        } else if (
          ts.isExpressionStatement(statement) &&
          ts.isCallExpression(statement.expression)
        ) {
          const call = statement.expression,
            helper = helpers.get(nameOf(call.expression));
          if (!helper) continue;
          const scope = new Map(env);
          helper.parameters.forEach((parameter, index) =>
            bind(parameter.name, literal(call.arguments[index], env), scope),
          );
          const array = env.get(helper.target);
          if (Array.isArray(array)) array.push(literal(helper.template, scope));
          else
            unresolved.push({
              line: lineOf(source, statement),
              reason: 'Unresolved local push target',
            });
        } else if (ts.isReturnStatement(statement)) {
          const value = literal(statement.expression, env);
          if (Array.isArray(value)) outputs.push(...value);
          else
            unresolved.push({line: lineOf(source, statement), reason: 'Unsupported return syntax'});
        } else if (!ts.isFunctionDeclaration(statement)) {
          // Top-level branches/loops are not interpreted. Their possible effects remain unreviewed.
          unresolved.push({
            line: lineOf(source, statement),
            reason: `Uninterpreted factory statement: ${ts.SyntaxKind[statement.kind]}`,
          });
        }
      }
      factories.push(
        providerRecord(
          file,
          source,
          declaration,
          'factory',
          outputs,
          unresolved,
          files[file],
          imageBase,
        ),
      );
    }
  }
  return factories.sort((a, b) => a.id.localeCompare(b.id));
}

function resolveModule(from, specifier, files, config) {
  if (!specifier.startsWith('.')) return undefined;
  let candidate = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  for (const alias of config.pathAliases ?? [])
    if (inRoot(candidate, alias.from)) candidate = alias.to + candidate.slice(alias.from.length);
  const candidates = [
    candidate,
    candidate.replace(/\.(?:m?js)$/, '.ts'),
    `${candidate}.ts`,
    `${candidate}/index.ts`,
  ];
  return candidates.find((file) => Object.hasOwn(files, file));
}

/** References mean syntactic imports/re-exports, including aliases/namespaces; never test coverage. */
export function attachReferences(factories, parsed, files, config) {
  const byFile = new Map();
  for (const factory of factories) {
    const list = byFile.get(factory.file) ?? [];
    list.push(factory);
    byFile.set(factory.file, list);
  }
  const aggregates = [];
  for (const [file, source] of parsed) {
    if (!config.referenceRoots.some((root) => inRoot(file, root))) continue;
    const kind = config.testRoots.some((root) => inRoot(file, root)) ? 'test' : 'source';
    const constructors = new Map();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const target = resolveModule(file, statement.moduleSpecifier.text, files, config);
      if (!target) continue;
      const bindings = ts.isImportDeclaration(statement)
        ? statement.importClause?.namedBindings
        : statement.exportClause;
      const typeOnly = statement.isTypeOnly || statement.importClause?.isTypeOnly;
      if (typeOnly) continue;
      const imported =
        bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings))
          ? bindings.elements
              .filter((binding) => !binding.isTypeOnly)
              .map((binding) => ({
                remote: nameOf(binding.propertyName ?? binding.name),
                local: nameOf(binding.name),
              }))
          : null;
      for (const factory of byFile.get(target) ?? []) {
        if (
          file === factory.file ||
          (imported && !imported.some((binding) => binding.remote === factory.export))
        )
          continue;
        factory.references.push({
          file,
          line: lineOf(source, statement),
          kind,
          form: ts.isExportDeclaration(statement)
            ? 're-export'
            : imported
              ? 'named-import'
              : 'namespace-or-module-import',
          sha256: sha256(files[file]),
        });
      }
      for (const symbol of config.aggregateSymbols ?? [])
        if (target === symbol.file && ts.isImportDeclaration(statement)) {
          if (imported) {
            for (const binding of imported)
              if (binding.remote === symbol.export) constructors.set(binding.local, symbol.export);
          } else if (bindings && ts.isNamespaceImport(bindings))
            constructors.set(`${bindings.name.text}.${symbol.export}`, symbol.export);
        }
    }
    if (kind === 'source' && constructors.size)
      walk(source, (node) => {
        if (ts.isNewExpression(node) && constructors.has(node.expression.getText(source)))
          aggregates.push({
            file,
            line: lineOf(source, node),
            symbol: constructors.get(node.expression.getText(source)),
            sha256: sha256(files[file]),
            state: 'construction-candidate-unverified',
          });
      });
  }
  for (const factory of factories)
    factory.references.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return aggregates.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

async function collectFiles(root, roots) {
  const files = {};
  root = await realpath(root);
  const checkRoot = async (relative) => {
    localPath(root, relative);
    let current = root;
    for (const part of relative.split('/')) {
      current = path.join(current, part);
      requireThat(
        !(await lstat(current)).isSymbolicLink(),
        `Symlinked source root is not audited: ${relative}`,
      );
    }
    requireThat(
      (await realpath(current)).startsWith(`${root}${path.sep}`),
      `Source root escapes canonical repository: ${relative}`,
    );
  };
  const visit = async (relative) => {
    const entries = await readdir(localPath(root, relative), {withFileTypes: true});
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const next = `${relative}/${entry.name}`;
      requireThat(!entry.isSymbolicLink(), `Symlinked source entry is not audited: ${next}`);
      if (entry.isDirectory()) await visit(next);
      else if (
        entry.isFile() &&
        /\.(?:ts|mjs|js)$/.test(entry.name) &&
        !entry.name.endsWith('.d.ts')
      )
        files[next] = await readFile(localPath(root, next), 'utf8');
    }
  };
  const directories = sort(new Set(roots));
  for (const directory of directories) await checkRoot(directory);
  for (const directory of directories.filter(
    (candidate) => !directories.some((parent) => parent !== candidate && inRoot(candidate, parent)),
  ))
    await visit(directory);
  return files;
}

export async function inspectSources(manifest, root) {
  root = await realpath(root);
  const files = await collectFiles(root, [
    ...manifest.discovery.definitionRoots,
    ...manifest.discovery.referenceRoots,
  ]);
  requireThat(
    Object.hasOwn(files, manifest.universe.path),
    'Inventory must be included in audited source roots',
  );
  const parsed = parseSources(files);
  const inventory = extractInventory(
    parsed.get(manifest.universe.path),
    manifest.universe.export,
    manifest.binary.imageBase,
  );
  const factories = discoverFactories(parsed, files, manifest.discovery, manifest.binary.imageBase);
  const aggregateCandidates = attachReferences(factories, parsed, files, manifest.discovery);
  return {
    inventory,
    inventorySha256: sha256(files[manifest.universe.path]),
    factories,
    aggregateCandidates,
    inputPaths: Object.keys(files).map((file) => localPath(root, file)),
  };
}

export function validateManifest(manifest) {
  requireThat(manifest.schemaVersion === 1, 'Unsupported slot-manifest schemaVersion');
  requireThat(
    HASH.test(manifest.binary?.sha256) && HEX.test(manifest.binary.imageBase),
    'Binary requires SHA-256 and canonical hexadecimal imageBase',
  );
  requireThat(
    Number.isInteger(manifest.universe?.expectedCount) && manifest.universe.expectedCount > 0,
    'Invalid expected slot count',
  );
  requireThat(
    Array.isArray(manifest.slots) && manifest.slots.length === manifest.universe.expectedCount,
    'Manifest slot count differs from authoritative universe',
  );
  requireThat(
    Array.isArray(manifest.universe.banks) &&
      new Set(manifest.universe.banks.map((bank) => bank.id)).size ===
        manifest.universe.banks.length,
    'Invalid or duplicate universe banks',
  );
  for (const bank of manifest.universe.banks)
    requireThat(
      /^[0-9a-f]{2}$/.test(bank.id) &&
        Number.isInteger(bank.count) &&
        bank.count > 0 &&
        bank.count <= 256 &&
        HASH.test(bank.tableSha256),
      `Invalid native table evidence ${bank.id}`,
    );
  requireThat(
    Array.isArray(manifest.owners) && new Set(manifest.owners).size === manifest.owners.length,
    'Invalid owner names',
  );
  const ownership = new Map(),
    evidenceIds = new Set(manifest.ownershipEvidence.map((evidence) => evidence.id));
  for (const rule of manifest.ownershipPolicy) {
    requireThat(
      /^[0-9a-f]{2}$/.test(rule.bank) &&
        manifest.owners.includes(rule.owner) &&
        evidenceIds.has(rule.evidence),
      'Invalid ownership policy',
    );
    for (const secondary of rule.slots) {
      const id = `${rule.bank}:${secondary}`;
      requireThat(
        SLOT.test(id) && !ownership.has(id),
        `Invalid or duplicate ownership policy ${id}`,
      );
      ownership.set(id, rule);
    }
  }
  requireThat(
    ownership.size === manifest.universe.expectedCount,
    'Ownership policy omits native slots',
  );
  const ids = new Set();
  for (const row of manifest.slots) {
    requireThat(
      SLOT.test(row.id) && !ids.has(row.id),
      `Invalid or duplicate manifest slot ${row.id}`,
    );
    ids.add(row.id);
    requireThat(HEX.test(row.rva), `Invalid RVA for ${row.id}`);
    requireThat(
      manifest.owners.includes(row.ownership?.owner) && row.ownership.state === 'assigned',
      `Invalid ownership for ${row.id}`,
    );
    requireThat(
      ownership.get(row.id)?.owner === row.ownership.owner &&
        ownership.get(row.id)?.evidence === row.ownership.evidence,
      `Ownership disagrees with imported policy for ${row.id}`,
    );
    requireThat(
      row.nativeEvidence?.state === 'table-attested-body-unreviewed',
      `Unrecognized native evidence state for ${row.id}`,
    );
    requireThat(
      row.nativeEvidence.bank === row.id.slice(0, 2),
      `Native evidence bank mismatch for ${row.id}`,
    );
    requireThat(
      ['declaration-observed', 'not-observed'].includes(row.source?.state) &&
        Array.isArray(row.source.factories),
      `Invalid source state for ${row.id}`,
    );
    requireThat(
      row.focusedTests?.state === 'unreviewed' && Array.isArray(row.focusedTests.factoryReferences),
      `Invalid focused-test state for ${row.id}`,
    );
    requireThat(
      ['no-aggregate-observed', 'construction-candidate-unverified'].includes(
        row.aggregateIntegration?.state,
      ),
      `Invalid integration state for ${row.id}`,
    );
  }
  for (const bank of manifest.universe.banks)
    requireThat(
      manifest.slots.filter((row) => row.id.startsWith(`${bank.id}:`)).length === bank.count,
      `Manifest bank count mismatch ${bank.id}`,
    );
  for (const evidence of manifest.ownershipEvidence) {
    requireThat(HASH.test(evidence.sha256), `Invalid imported evidence hash ${evidence.id}`);
    for (const [owner, expected] of Object.entries(evidence.expectedCounts ?? {})) {
      const count = manifest.slots.filter(
        (row) =>
          row.ownership.owner === owner &&
          (!evidence.scopeBanks || evidence.scopeBanks.includes(row.id.slice(0, 2))),
      ).length;
      requireThat(count === expected, `Ownership count mismatch for ${evidence.id}/${owner}`);
    }
  }
  const factoryIds = new Set();
  for (const factory of manifest.factories) {
    requireThat(
      ['factory', 'constant-array', 'constant-slot'].includes(factory.kind),
      `Invalid provider kind ${factory.id}`,
    );
    requireThat(
      !factoryIds.has(factory.id) && HASH.test(factory.sha256),
      `Invalid or duplicate factory ${factory.id}`,
    );
    factoryIds.add(factory.id);
    requireThat(
      factory.id === `${factory.file}#${factory.export}`,
      `Factory identity mismatch ${factory.id}`,
    );
    requireThat(
      Array.isArray(factory.entries) &&
        Array.isArray(factory.references) &&
        Array.isArray(factory.unresolved),
      `Invalid factory shape ${factory.id}`,
    );
  }
  for (const row of manifest.slots) {
    for (const factoryId of row.source.factories)
      requireThat(factoryIds.has(factoryId), `Unknown source factory ${factoryId}`);
    requireThat(
      row.source.state === (row.source.factories.length ? 'declaration-observed' : 'not-observed'),
      `Source state disagrees with factory references for ${row.id}`,
    );
  }
  return manifest;
}

export function refreshObservations(manifest, observation) {
  manifest.factories = observation.factories;
  manifest.aggregateCandidates = observation.aggregateCandidates;
  for (const row of manifest.slots) {
    const factories = observation.factories.filter((factory) =>
      factory.entries.some((entry) => entry.slot === row.id && entry.rva === row.rva),
    );
    row.source = {
      state: factories.length ? 'declaration-observed' : 'not-observed',
      factories: factories.map((factory) => factory.id),
    };
    row.focusedTests = {
      state: 'unreviewed',
      factoryReferences: factories
        .filter((factory) => factory.references.some((reference) => reference.kind === 'test'))
        .map((factory) => factory.id),
    };
    row.aggregateIntegration = {
      state: observation.aggregateCandidates.length
        ? 'construction-candidate-unverified'
        : 'no-aggregate-observed',
    };
  }
  return manifest;
}

/** A proposed partial assembly is data. This function never constructs a runtime bank. */
export function auditPartialAggregation(manifest, plan = null) {
  const rows = new Map(manifest.slots.map((row) => [row.id, row]));
  if (plan === null)
    return {
      state: 'no-aggregate-supplied',
      complete: false,
      missing: [...rows.keys()],
      duplicates: [],
      wrongOwners: [],
      wrongAddresses: [],
      unknownSlots: [],
      wrongFactories: [],
    };
  requireThat(
    plan.schemaVersion === 1 &&
      plan.binarySha256 === manifest.binary.sha256 &&
      Array.isArray(plan.entries),
    'Partial plan requires schemaVersion 1, matching binarySha256 and entries',
  );
  const seen = new Map(),
    duplicates = [],
    wrongOwners = [],
    wrongAddresses = [],
    unknownSlots = [],
    wrongFactories = [],
    valid = new Set();
  for (const [index, entry] of plan.entries.entries()) {
    requireThat(
      entry &&
        SLOT.test(entry.slot) &&
        typeof entry.owner === 'string' &&
        HEX.test(entry.rva) &&
        typeof entry.factory === 'string',
      `Malformed partial entry ${index}`,
    );
    if (seen.has(entry.slot))
      duplicates.push({slot: entry.slot, indices: [seen.get(entry.slot), index]});
    else seen.set(entry.slot, index);
    const row = rows.get(entry.slot);
    if (!row) {
      unknownSlots.push(entry.slot);
      continue;
    }
    const ownerOk = row.ownership.owner === entry.owner,
      addressOk = row.rva === entry.rva,
      factoryOk = row.source.factories.includes(entry.factory);
    if (!ownerOk)
      wrongOwners.push({slot: entry.slot, expected: row.ownership.owner, actual: entry.owner});
    if (!addressOk) wrongAddresses.push({slot: entry.slot, expected: row.rva, actual: entry.rva});
    if (!factoryOk) wrongFactories.push({slot: entry.slot, factory: entry.factory});
    if (ownerOk && addressOk && factoryOk) valid.add(entry.slot);
  }
  const missing = [...rows.keys()].filter((id) => !valid.has(id));
  const invalid =
    duplicates.length +
    wrongOwners.length +
    wrongAddresses.length +
    unknownSlots.length +
    wrongFactories.length;
  return {
    state: invalid
      ? 'invalid-partial-plan'
      : missing.length
        ? 'partial-plan'
        : 'all-slots-declared-unverified',
    complete: false,
    missing,
    duplicates,
    wrongOwners,
    wrongAddresses,
    unknownSlots,
    wrongFactories,
  };
}

export function auditObservations(manifest, observation, plan = null) {
  validateManifest(manifest);
  const errors = [],
    warnings = [];
  const error = (code, details) => errors.push({code, ...details});
  if (manifest.universe.sha256 !== observation.inventorySha256)
    error('inventory-source-drift', {path: manifest.universe.path});
  const expectedRows = manifest.slots
    .map(({id, rva}) => ({id, rva}))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (
    !equal(expectedRows, observation.inventory.rows) ||
    observation.inventory.rows.length !== manifest.universe.expectedCount ||
    manifest.universe.canonicalSha256 !== observation.inventory.canonicalSha256
  )
    error('slot-universe-mismatch', {});
  if (manifest.universe.banks.length !== observation.inventory.banks.length)
    error('native-bank-count-mismatch', {});
  for (const bank of manifest.universe.banks) {
    const current = observation.inventory.banks.find((value) => value.id === bank.id);
    if (!current || current.count !== bank.count || current.tableSha256 !== bank.tableSha256)
      error('native-table-hash-mismatch', {bank: bank.id});
  }
  const observedFactories = new Map(observation.factories.map((factory) => [factory.id, factory]));
  for (const factory of manifest.factories) {
    const observed = observedFactories.get(factory.id);
    if (!observed) error('factory-missing', {factory: factory.id});
    else if (!equal(factory, observed))
      error('factory-source-or-reference-drift', {factory: factory.id});
  }
  for (const factory of observation.factories)
    if (!manifest.factories.some((old) => old.id === factory.id))
      error('unrecorded-factory', {factory: factory.id});
  const refreshed = refreshObservations(structuredClone(manifest), observation);
  for (let index = 0; index < manifest.slots.length; index++) {
    const old = manifest.slots[index],
      current = refreshed.slots[index];
    if (
      !equal(old.source, current.source) ||
      !equal(old.focusedTests, current.focusedTests) ||
      !equal(old.aggregateIntegration, current.aggregateIntegration)
    )
      error('slot-observation-drift', {slot: old.id});
  }
  if (!equal(manifest.aggregateCandidates, observation.aggregateCandidates))
    error('aggregate-observation-drift', {});
  const definitions = new Map(),
    slotMap = new Map(manifest.slots.map((row) => [row.id, row]));
  for (const factory of observation.factories) {
    for (const entry of factory.entries) {
      const row = slotMap.get(entry.slot);
      if (!row || row.rva !== entry.rva)
        error('factory-slot-address-mismatch', {factory: factory.id, entry});
      const existing = definitions.get(entry.slot) ?? [];
      existing.push(factory.id);
      definitions.set(entry.slot, existing);
    }
    if (factory.unresolved.length)
      warnings.push({
        code: 'factory-syntax-unresolved',
        factory: factory.id,
        details: factory.unresolved,
      });
  }
  const duplicateDeclarations = [...definitions]
    .filter(([, values]) => values.length > 1)
    .map(([slot, factories]) => ({slot, factories}));
  for (const duplicate of duplicateDeclarations)
    warnings.push({code: 'duplicate-source-declarations', ...duplicate});
  const testOnlyProviders = observation.factories
    .filter(
      (factory) =>
        factory.references.some((reference) => reference.kind === 'test') &&
        !factory.references.some((reference) => reference.kind === 'source'),
    )
    .map((factory) => factory.id);
  const testOnlyFactories = testOnlyProviders.filter(
    (id) => observation.factories.find((provider) => provider.id === id).kind === 'factory',
  );
  const aggregate = auditPartialAggregation(refreshed, plan);
  if (aggregate.state === 'invalid-partial-plan')
    error('invalid-partial-plan', {details: aggregate});
  const banks = manifest.universe.banks.map((bank) => {
    const rows = refreshed.slots.filter((row) => row.id.startsWith(`${bank.id}:`));
    return {
      bank: bank.id,
      total: rows.length,
      sourceDeclarations: rows.filter((row) => row.source.state === 'declaration-observed').length,
      providerTestReferences: rows.filter((row) => row.focusedTests.factoryReferences.length)
        .length,
      factoryTestReferences: rows.filter((row) =>
        row.focusedTests.factoryReferences.some(
          (id) => observation.factories.find((provider) => provider.id === id).kind === 'factory',
        ),
      ).length,
      nativeBodiesReviewed: 0,
      focusedTestsAccepted: 0,
      aggregateVerified: 0,
    };
  });
  return {
    schemaVersion: 1,
    kind: 'native-slot-static-audit',
    binarySha256: manifest.binary.sha256,
    status: errors.length ? 'failed' : 'observations-consistent-integration-unverified',
    ok: errors.length === 0,
    complete: false,
    counts: {
      total: manifest.slots.length,
      owners: Object.fromEntries(
        manifest.owners.map((owner) => [
          owner,
          manifest.slots.filter((row) => row.ownership.owner === owner).length,
        ]),
      ),
      sourceDeclarations: banks.reduce((n, bank) => n + bank.sourceDeclarations, 0),
      factoryTestReferences: banks.reduce((n, bank) => n + bank.factoryTestReferences, 0),
      providerTestReferences: banks.reduce((n, bank) => n + bank.providerTestReferences, 0),
      factories: observation.factories.filter((provider) => provider.kind === 'factory').length,
      staticProviders: observation.factories.filter((provider) => provider.kind !== 'factory')
        .length,
      providers: observation.factories.length,
      testOnlyFactories: testOnlyFactories.length,
      testOnlyProviders: testOnlyProviders.length,
      nativeBodiesReviewed: 0,
      focusedTestsAccepted: 0,
      aggregateVerified: 0,
    },
    banks,
    errors,
    warnings,
    missingSource: refreshed.slots
      .filter((row) => row.source.state === 'not-observed')
      .map((row) => row.id),
    duplicateDeclarations,
    testOnlyFactories,
    testOnlyProviders,
    aggregateCandidates: observation.aggregateCandidates,
    aggregate,
  };
}

export function renderCounts(report) {
  const lines = [
    '<!-- BEGIN GENERATED NATIVE SLOT COUNTS -->',
    `Binary SHA-256: \`${report.binarySha256}\`.`,
    '',
    `The manifest contains **${report.counts.total} native slots**. Ownership: ${Object.entries(
      report.counts.owners,
    )
      .map(([owner, count]) => `${owner} ${count}`)
      .join(', ')}.`,
    '',
    '| Bank | Native slots | Source declarations observed | Provider referenced by tests | Accepted focused tests | Verified aggregate slots |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...report.banks.map(
      (bank) =>
        `| ${bank.bank.toUpperCase()} | ${bank.total} | ${bank.sourceDeclarations} | ${bank.providerTestReferences} | ${bank.focusedTestsAccepted} | ${bank.aggregateVerified} |`,
    ),
    '',
    `${report.counts.factories} exported factories and ${report.counts.staticProviders} static declaration providers were found; ${report.counts.testOnlyFactories} factories and ${report.counts.testOnlyProviders - report.counts.testOnlyFactories} static providers have references only in tests. ${report.missingSource.length} slots have no recognized source declaration. ${report.duplicateDeclarations.length} slots have multiple source declarations.`,
    '',
    `Aggregate state: \`${report.aggregate.state}\`; production construction candidates: ${report.aggregateCandidates.length}. Body-review, focused-test acceptance, and runtime integration are unreviewed in this manifest. These zero acceptance counts describe imported evidence, not a denial of historical test receipts.`,
    '<!-- END GENERATED NATIVE SLOT COUNTS -->',
  ];
  return `${lines.join('\n')}\n`;
}

async function main(argv) {
  const [command, manifestPath, ...rest] = argv;
  if (!['audit', 'refresh', 'docs'].includes(command) || !manifestPath) {
    console.log(
      'Usage: node tools/native-audit/slots.mjs <audit|refresh|docs> MANIFEST [--root DIR] [--aggregate PLAN.json] [--out FILE] [--require-integrated]\nAudit exits 0 for consistent static observations, 1 for drift/invalid data, 2 when --require-integrated cannot establish complete integration. refresh requires --out and never advances review/acceptance states. docs writes a generated counts block or replaces that block in an existing --out file.',
    );
    process.exitCode = command ? 1 : 0;
    return;
  }
  const options = {};
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    requireThat(
      ['--root', '--aggregate', '--out', '--require-integrated'].includes(flag),
      `Unknown option ${flag}`,
    );
    if (flag === '--require-integrated') options[flag] = true;
    else {
      requireThat(
        rest[index + 1] && !rest[index + 1].startsWith('--'),
        `Missing value for ${flag}`,
      );
      options[flag] = rest[++index];
    }
  }
  const root = await realpath(path.resolve(options['--root'] ?? process.cwd()));
  const manifestInput = await realpath(path.resolve(manifestPath));
  const manifest = validateManifest(JSON.parse(await readFile(manifestInput, 'utf8')));
  const observation = await inspectSources(manifest, root);
  const planInput = options['--aggregate']
    ? await realpath(path.resolve(options['--aggregate']))
    : null;
  const plan = planInput ? JSON.parse(await readFile(planInput, 'utf8')) : null;
  const inputs = new Set([
    ...observation.inputPaths,
    manifestInput,
    ...(planInput ? [planInput] : []),
  ]);
  const prepareOutput = async (kind) => {
    const requested = path.resolve(options['--out']);
    const destination = path.join(
      await realpath(path.dirname(requested)),
      path.basename(requested),
    );
    let existing;
    try {
      existing = await lstat(destination);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    requireThat(!existing?.isSymbolicLink(), 'Refusing to write through a symlinked output');
    requireThat(!existing || existing.isFile(), 'Output must be a regular file');
    if (kind === 'refresh') {
      requireThat(
        !existing || destination === manifestInput,
        'Refresh may replace only its input manifest; use a new output path',
      );
    } else requireThat(!inputs.has(destination), 'Output must not overwrite an audit input');
    return {destination, existing: Boolean(existing)};
  };
  if (command === 'refresh') {
    requireThat(options['--out'], 'refresh requires --out; review the resulting manifest diff');
    const refreshed = refreshObservations(structuredClone(manifest), observation);
    const report = auditObservations(refreshed, observation, plan);
    requireThat(
      report.ok,
      `Cannot refresh across inventory/address errors: ${JSON.stringify(report.errors)}`,
    );
    const output = await prepareOutput('refresh');
    await writeFile(output.destination, `${JSON.stringify(refreshed, null, 2)}\n`, {
      flag: output.existing ? 'w' : 'wx',
    });
    console.log(
      JSON.stringify(
        {
          status: 'observations-refreshed-review-states-unchanged',
          out: options['--out'],
          counts: report.counts,
        },
        null,
        2,
      ),
    );
    return;
  }
  const report = auditObservations(manifest, observation, plan);
  let output = command === 'docs' ? renderCounts(report) : `${JSON.stringify(report, null, 2)}\n`;
  if (options['--out']) {
    const target = await prepareOutput(command);
    if (command === 'docs') {
      requireThat(report.ok, 'Refusing to publish counts for a manifest with audit errors');
      let previous = '';
      if (target.existing) previous = await readFile(target.destination, 'utf8');
      const begin = '<!-- BEGIN GENERATED NATIVE SLOT COUNTS -->',
        end = '<!-- END GENERATED NATIVE SLOT COUNTS -->';
      requireThat(
        !target.existing || previous.includes(begin),
        'Existing documentation must contain the generated block markers',
      );
      if (previous.includes(begin)) {
        requireThat(previous.includes(end), 'Missing end marker in generated documentation');
        output =
          previous.slice(0, previous.indexOf(begin)) +
          output.trimEnd() +
          previous.slice(previous.indexOf(end) + end.length);
      }
    }
    await writeFile(target.destination, output, {
      flag: command === 'docs' && target.existing ? 'w' : 'wx',
    });
    console.log(
      JSON.stringify(
        {status: report.status, out: options['--out'], counts: report.counts},
        null,
        2,
      ),
    );
  } else process.stdout.write(output);
  process.exitCode = !report.ok ? 1 : options['--require-integrated'] ? 2 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`native slots: ${error.message}`);
    process.exitCode = 1;
  });
}
