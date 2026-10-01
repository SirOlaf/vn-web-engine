#!/usr/bin/env node
// Generates the language files of the BGI Ghidra extension that derive from the engine
// sources: the operand-stack plumbing (bgi_stack.sinc), the compiler spec (bgi.cspec) and,
// per revision, the native slot table (bgi_natives_<rev>.json, read by the Java analysis)
// and native constructors (bgi_natives_<rev>.sinc). build.mjs runs it into the staged
// extension; the outputs are not kept in the source tree.
//
// A slot's name comes from the definition whose verified native address matches
// that revision's inventory entry, falling back to the 1.685.3 definition for the
// same primary/secondary pair. Operand-stack effects are counted statically from
// the definition's handler (see docs/tooling/ghidra-bgi.md); data-dependent effects
// are recorded as unknown (null) and estimated by the Ghidra stack analysis.
//
// Usage: node tools/ghidra-bgi/generate-sleigh.mjs --out DIR

import {mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const BURIKO = join(REPO, 'src', 'engines', 'buriko');

/** Each Ghidra language variant and the inventory module/exports describing it. */
export const REVISIONS = [
  {
    id: '1685',
    revision: '1.685.3',
    inventory: 'inventory.ts',
    table: 'BURIKO_NATIVE_SLOT_ADDRESSES',
    primaries: 'BURIKO_PRIMARY_SLOT_ADDRESSES',
  },
  {
    id: '1665',
    revision: '1.665',
    inventory: 'inventory-1665.ts',
    table: 'BURIKO_1665_NATIVE_SLOT_ADDRESSES',
    primaries: 'BURIKO_1665_PRIMARY_SLOT_ADDRESSES',
  },
  {
    id: '1658',
    revision: '1.658.5',
    inventory: 'inventory-1658.ts',
    table: 'BURIKO_1658_NATIVE_SLOT_ADDRESSES',
    primaries: 'BURIKO_1658_PRIMARY_SLOT_ADDRESSES',
  },
  {
    id: '1520',
    revision: '1.520.6',
    inventory: 'inventory-169.ts',
    table: 'BURIKO_169_NATIVE_SLOT_ADDRESSES',
    primaries: 'BURIKO_169_PRIMARY_SLOT_ADDRESSES',
  },
];

function walkFiles(directory) {
  const result = [];
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(path));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) result.push(path);
  }
  return result.sort();
}

function parse(path) {
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
}

function numericLiteral(node) {
  if (node && ts.isNumericLiteral(node)) return Number(node.text);
  return null;
}

/** Reads `{0x80: {0x00: 0x1400ea390, ...}}` from an inventory export. */
function readInventory(file, exportName) {
  const source = parse(join(BURIKO, 'native', file));
  let table = null;
  ts.forEachChild(source, (node) => {
    if (!ts.isVariableStatement(node)) return;
    for (const declaration of node.declarationList.declarations) {
      if (declaration.name.getText() !== exportName) continue;
      let init = declaration.initializer;
      while (init && (ts.isAsExpression(init) || ts.isSatisfiesExpression?.(init)))
        init = init.expression;
      table = new Map();
      for (const primaryProperty of init.properties) {
        const primary = Number(primaryProperty.name.getText());
        if (!ts.isObjectLiteralExpression(primaryProperty.initializer)) {
          table.set(primary, numericLiteral(primaryProperty.initializer));
          continue;
        }
        const slots = new Map();
        for (const slot of primaryProperty.initializer.properties)
          slots.set(Number(slot.name.getText()), numericLiteral(slot.initializer));
        table.set(primary, slots);
      }
    }
  });
  if (table === null) throw new Error(`${file} has no ${exportName}`);
  return table;
}

// ---------------------------------------------------------------------------
// Operand-stack effect summaries

const POPS = new Set(['pop32', 'popDeferred32']);
const PUSHES = new Set(['push32', 'pushIndeterminate32']);
const ITERATING = new Set([
  'map',
  'forEach',
  'filter',
  'some',
  'every',
  'reduce',
  'reduceRight',
  'flatMap',
  'find',
  'findIndex',
  'from',
  'sort',
]);

// An effect lists the pops in pop order (each {kind: 'int' | 'ptr'}) and counts the pushes
// of the path that continues after a fragment; null means data-dependent. `exits` marks a
// fragment that never continues. `completions` are the effects, from the fragment's start,
// at each `return` inside it: 'success' for `return 0`, 'deferred' for `return <nonzero>`
// (a wait process pushes the result later), otherwise 'normal'. Returns that cannot complete
// (a `never` call) and throws are not completions.
const UNKNOWN = Object.freeze({pops: null, pushes: null, exits: false, completions: []});
const NONE = Object.freeze({pops: [], pushes: 0, exits: false, completions: []});

const concat = (a, b) => (a === null || b === null ? null : [...a, ...b]);
const add = (a, b) => (a === null || b === null ? null : a + b);

function sequence(a, b) {
  if (a.exits) return a;
  return {
    pops: concat(a.pops, b.pops),
    pushes: add(a.pushes, b.pushes),
    exits: b.exits,
    completions: [
      ...a.completions,
      ...b.completions.map((c) => ({
        pops: concat(a.pops, c.pops),
        pushes: add(a.pushes, c.pushes),
        kind: c.kind,
      })),
    ],
  };
}

/** Two plain effects agree, or the result is data-dependent. */
function agree(a, b) {
  if (a.pops === null || b.pops === null || a.pops.length !== b.pops.length) return UNKNOWN;
  if (a.pushes !== b.pushes) return UNKNOWN;
  // A cell is a pointer only when every alternative resolves it.
  const pops = a.pops.map((pop, i) => ({kind: pop.kind === b.pops[i].kind ? pop.kind : 'int'}));
  return {pops, pushes: a.pushes, exits: false, completions: []};
}

/** Alternatives keep all completions; the continuing paths must agree. */
function alternative(a, b) {
  const completions = [...a.completions, ...b.completions];
  if (a.exits && b.exits) return {...a, exits: true, completions};
  if (a.exits) return {...b, completions};
  if (b.exits) return {...a, completions};
  return {...agree(a, b), completions};
}

/**
 * A whole function. Handlers report success with `return 0`; those completions are used
 * when present, then other returns and the end of the body, then deferred ones. The chosen
 * completions must agree.
 */
function finish(effect) {
  const completions = [...effect.completions];
  if (!effect.exits) completions.push({pops: effect.pops, pushes: effect.pushes, kind: 'normal'});
  const of = (kind) => completions.filter((c) => c.kind === kind);
  const chosen = [of('success'), of('normal'), of('deferred')].find((list) => list.length) ?? [];
  if (!chosen.length) return NONE;
  const merged = chosen
    .map((c) => ({pops: c.pops, pushes: c.pushes, exits: false, completions: []}))
    .reduce((a, b) => agree(a, b));
  // A deferred completion's wait process may push a result later: pops stay exact, the
  // result count is unknown.
  return chosen[0].kind === 'deferred' ? {...merged, pushes: null} : merged;
}

function hasEffect(e) {
  return e.pops === null || e.pops.length !== 0 || e.pushes !== 0;
}

/** Copies pop records so that marking a caller's use cannot change a cached callee summary. */
function fresh(e) {
  return e.pops === null ? e : {...e, pops: e.pops.map((pop) => ({...pop}))};
}

const unwrapValue = (node) => {
  for (;;) {
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isAsExpression(node)
    )
      node = node.expression;
    else if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarToken) &&
      ts.isNumericLiteral(node.right) &&
      Number(node.right.text) === 0
    )
      node = node.left;
    else return node;
  }
};

const isPopCall = (node) =>
  ts.isCallExpression(node) && ts.isIdentifier(node.expression) && POPS.has(node.expression.text);

/** Expressions a function returns, excluding those of nested functions. */
function returnedExpressions(fn) {
  if (!ts.isBlock(fn.body)) return [fn.body];
  const result = [];
  const visit = (node) => {
    if (ts.isFunctionLike(node) && node !== fn) return;
    if (ts.isReturnStatement(node) && node.expression) result.push(node.expression);
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return result;
}

class EffectAnalyzer {
  constructor(files) {
    /** name -> function-like nodes declared at module scope anywhere under the engine. */
    this.globalFunctions = new Map();
    /** method name -> class methods under the engine that touch the operand stack. */
    this.stackMethods = new Map();
    /** method name -> every class method under the engine. */
    this.methods = new Map();
    this.cache = new Map();
    /** Per analysed function: variable name -> pop record it holds. */
    this.bindings = [];
    for (const source of files) {
      const add = (map, name, node) => {
        if (!map.has(name)) map.set(name, []);
        map.get(name).push(node);
      };
      const visit = (node) => {
        if (ts.isFunctionDeclaration(node) && node.name && node.body)
          add(this.globalFunctions, node.name.text, node);
        else if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer &&
          (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
        )
          add(this.globalFunctions, node.name.text, node.initializer);
        else if (
          ts.isMethodDeclaration(node) &&
          node.body &&
          node.name &&
          ts.isIdentifier(node.name)
        ) {
          add(this.methods, node.name.text, node);
          if (/\b(pop32|popDeferred32|push32|pushIndeterminate32)\(/.test(node.body.getText()))
            add(this.stackMethods, node.name.text, node);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }

  /** Function declared in an enclosing scope of `site`, else at module scope of any file. */
  resolve(name, site) {
    for (let scope = site.parent; scope; scope = scope.parent) {
      if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
      for (const statement of scope.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name?.text === name)
          return [statement];
        if (ts.isVariableStatement(statement))
          for (const declaration of statement.declarationList.declarations)
            if (
              ts.isIdentifier(declaration.name) &&
              declaration.name.text === name &&
              declaration.initializer &&
              (ts.isArrowFunction(declaration.initializer) ||
                ts.isFunctionExpression(declaration.initializer))
            )
              return [declaration.initializer];
      }
    }
    return this.globalFunctions.get(name) ?? [];
  }

  summarize(fn) {
    if (this.cache.has(fn)) {
      const cached = this.cache.get(fn);
      return cached === 'pending' ? UNKNOWN : fresh(cached);
    }
    this.cache.set(fn, 'pending');
    const body = fn.body;
    this.bindings.push(new Map());
    const effect = finish(ts.isBlock(body) ? this.block(body.statements) : this.expression(body));
    this.bindings.pop();
    this.cache.set(fn, effect);
    return effect;
  }

  /** A definition's handler: a function, a named function, or an unanalysable expression. */
  handler(node) {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node))
      return this.summarize(node);
    if (ts.isIdentifier(node)) {
      const resolved = this.resolve(node.text, node);
      return resolved.length ? this.callees(resolved) : UNKNOWN;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      // A factory: the handler is the function, or the definition's `execute`, it returns.
      let effect = null;
      for (const factory of this.resolve(node.expression.text, node)) {
        for (const returned of returnedExpressions(factory)) {
          let candidate = unwrap(returned);
          if (ts.isObjectLiteralExpression(candidate)) candidate = handlerOf(candidate);
          if (
            !candidate ||
            !(
              ts.isArrowFunction(candidate) ||
              ts.isFunctionExpression(candidate) ||
              ts.isMethodDeclaration(candidate)
            )
          )
            continue;
          const next = this.summarize(candidate);
          effect = effect === null ? next : alternative(effect, next);
        }
      }
      return effect ?? UNKNOWN;
    }
    return UNKNOWN;
  }

  callees(nodes) {
    let effect = null;
    for (const node of nodes) {
      const next = this.summarize(node);
      effect = effect === null ? next : alternative(effect, next);
    }
    return effect;
  }

  block(statements) {
    let effect = NONE;
    for (const statement of statements) {
      effect = sequence(effect, this.statement(statement));
      if (effect.exits) break;
    }
    return effect;
  }

  statement(node) {
    if (ts.isBlock(node)) return this.block(node.statements);
    if (ts.isExpressionStatement(node)) return this.expression(node.expression);
    if (ts.isVariableStatement(node)) {
      let effect = NONE;
      for (const declaration of node.declarationList.declarations) {
        if (!declaration.initializer) continue;
        const e = this.expression(declaration.initializer);
        if (
          ts.isIdentifier(declaration.name) &&
          isPopCall(unwrapValue(declaration.initializer)) &&
          e.pops?.length === 1 &&
          this.bindings.length
        )
          this.bindings.at(-1).set(declaration.name.text, e.pops[0]);
        effect = sequence(effect, e);
      }
      return effect;
    }
    if (ts.isReturnStatement(node)) {
      const e = node.expression ? this.expression(node.expression) : NONE;
      if (node.expression && this.neverReturns(node.expression))
        return {...e, exits: true, completions: []};
      const value = node.expression && unwrapValue(node.expression);
      const literal = value && ts.isNumericLiteral(value) ? Number(value.text) : null;
      const kind = literal === 0 ? 'success' : literal !== null ? 'deferred' : 'normal';
      return {
        ...e,
        exits: true,
        completions: [...e.completions, {pops: e.pops, pushes: e.pushes, kind}],
      };
    }
    if (ts.isThrowStatement(node))
      return {...this.expression(node.expression), exits: true, completions: []};
    if (ts.isIfStatement(node)) {
      const condition = this.expression(node.expression);
      const whenTrue = this.statement(node.thenStatement);
      const whenFalse = node.elseStatement ? this.statement(node.elseStatement) : NONE;
      return sequence(condition, alternative(whenTrue, whenFalse));
    }
    if (
      ts.isForStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node)
    ) {
      // A loop with stack effects has a data-dependent count; returns inside a loop
      // without them complete with the effect from before the loop.
      let effect = NONE;
      const completions = [];
      ts.forEachChild(node, (child) => {
        const e = ts.isStatement(child) ? this.statement(child) : this.expression(child);
        if (hasEffect({...e, pops: e.exits ? [] : e.pops, pushes: e.exits ? 0 : e.pushes}))
          effect = UNKNOWN;
        completions.push(...e.completions);
      });
      return effect === UNKNOWN ? UNKNOWN : {...NONE, completions};
    }
    if (ts.isSwitchStatement(node)) {
      const discriminant = this.expression(node.expression);
      let effect = null;
      let hasDefault = false;
      for (const clause of node.caseBlock.clauses) {
        if (ts.isDefaultClause(clause)) hasDefault = true;
        const e = this.block(clause.statements.filter((s) => !ts.isBreakStatement(s)));
        effect = effect === null ? e : alternative(effect, e);
      }
      if (effect === null) return discriminant;
      if (!hasDefault) effect = alternative(effect, NONE);
      return sequence(discriminant, {...effect, exits: effect.exits && hasDefault});
    }
    if (ts.isTryStatement(node)) {
      let effect = this.block(node.tryBlock.statements);
      if (node.finallyBlock) {
        const after = this.block(node.finallyBlock.statements);
        effect = {...sequence({...effect, exits: false}, after), completions: effect.completions};
      }
      return effect;
    }
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEmptyStatement(node))
      return NONE;
    if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) return NONE;
    if (ts.isLabeledStatement(node)) return this.statement(node.statement);
    return UNKNOWN;
  }

  /**
   * A returned call that cannot complete: its declared type is `never`/`Promise<never>`, or
   * every value it returns is such a call (for example `errors.threadFatal(...)`).
   */
  neverReturns(expression, seen = new Set()) {
    let value = unwrapValue(expression);
    while (ts.isAwaitExpression(value)) value = unwrapValue(value.expression);
    if (ts.isConditionalExpression(value))
      return this.neverReturns(value.whenTrue, seen) && this.neverReturns(value.whenFalse, seen);
    if (!ts.isCallExpression(value)) return false;
    const callee = value.expression;
    const candidates = ts.isIdentifier(callee)
      ? this.resolve(callee.text, value)
      : ts.isPropertyAccessExpression(callee)
        ? (this.methods.get(callee.name.text) ?? [])
        : [];
    if (!candidates.length) return false;
    return candidates.every((fn) => {
      if (fn.type && /^(never|Promise<never>)$/.test(fn.type.getText().replace(/\s/g, '')))
        return true;
      if (seen.has(fn) || !fn.body) return false;
      seen.add(fn);
      const returned = returnedExpressions(fn);
      return returned.length > 0 && returned.every((r) => this.neverReturns(r, seen));
    });
  }

  /** A popped cell passed to memory.resolve is a VM pointer. */
  markPointer(argument, effect) {
    const value = unwrapValue(argument);
    if (isPopCall(value) && effect.pops?.length === 1) effect.pops[0].kind = 'ptr';
    else if (ts.isIdentifier(value))
      for (let i = this.bindings.length - 1; i >= 0; i--) {
        const pop = this.bindings[i].get(value.text);
        if (pop) {
          pop.kind = 'ptr';
          break;
        }
      }
  }

  call(node) {
    let effect = NONE;
    const callee = node.expression;
    let name = null;
    let method = null;
    if (ts.isIdentifier(callee)) name = callee.text;
    else if (ts.isPropertyAccessExpression(callee)) {
      effect = this.expression(callee.expression);
      method = callee.name.text;
    } else effect = this.expression(callee);
    for (const argument of node.arguments) {
      if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) {
        const inner = this.summarize(argument);
        // Callbacks run once for promise continuations; iteration callbacks repeat.
        if (method !== null && ITERATING.has(method) && hasEffect(inner)) return UNKNOWN;
        effect = sequence(effect, inner);
      } else if (ts.isIdentifier(argument) && (method === 'then' || method === 'finally')) {
        const resolved = this.resolve(argument.text, node);
        effect = sequence(effect, resolved.length ? this.callees(resolved) : NONE);
      } else {
        const e = this.expression(argument);
        if (method === 'resolve' || name === 'resolve') this.markPointer(argument, e);
        effect = sequence(effect, e);
      }
    }
    if (name !== null) {
      if (POPS.has(name)) return sequence(effect, {...NONE, pops: [{kind: 'int'}]});
      if (PUSHES.has(name)) return sequence(effect, {...NONE, pushes: 1});
      const resolved = this.resolve(name, node);
      if (resolved.length) return sequence(effect, this.callees(resolved));
      return effect;
    }
    if (method !== null && ITERATING.has(method)) return effect;
    // Class methods are resolved by name only when a method of that name touches the
    // operand stack itself; unrelated same-named methods are common.
    if (method !== null && this.stackMethods.has(method)) {
      const summary = this.callees(this.stackMethods.get(method));
      return sequence(effect, summary);
    }
    return effect;
  }

  expression(node) {
    if (!node) return NONE;
    if (ts.isCallExpression(node)) return this.call(node);
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return NONE;
    if (ts.isConditionalExpression(node))
      return sequence(
        this.expression(node.condition),
        alternative(this.expression(node.whenTrue), this.expression(node.whenFalse)),
      );
    if (ts.isBinaryExpression(node)) {
      const left = this.expression(node.left),
        right = this.expression(node.right);
      const kind = node.operatorToken.kind;
      if (
        kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        kind === ts.SyntaxKind.BarBarToken ||
        kind === ts.SyntaxKind.QuestionQuestionToken
      )
        return sequence(left, alternative(right, NONE));
      return sequence(left, right);
    }
    let effect = NONE;
    ts.forEachChild(node, (child) => {
      effect = sequence(effect, this.expression(child));
    });
    return effect;
  }
}

// ---------------------------------------------------------------------------
// Definition discovery

/** Function-valued `execute` property of an object, or the first function argument of a call. */
function handlerOf(node) {
  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (property.name?.getText() !== 'execute') continue;
      if (ts.isPropertyAssignment(property)) return property.initializer;
      if (ts.isMethodDeclaration(property)) return property;
    }
    return null;
  }
  if (ts.isCallExpression(node))
    return (
      node.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a)) ??
      node.arguments.find((a) => ts.isCallExpression(a)) ??
      node
    );
  return null;
}

function nameOf(node, address) {
  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties)
      if (property.name?.getText() === 'name' && ts.isPropertyAssignment(property)) {
        const value = property.initializer;
        if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))
          return value.text;
      }
    return null;
  }
  if (ts.isCallExpression(node)) {
    // add(secondary, nativeAddress, name, ...): the name follows the address.
    const index = node.arguments.findIndex((a) => a === address);
    let candidate = index >= 0 ? node.arguments[index + 1] : undefined;
    if (candidate && ts.isConditionalExpression(candidate)) candidate = candidate.whenFalse;
    if (candidate && ts.isStringLiteral(candidate)) return candidate.text;
    return node.arguments.find((a) => ts.isStringLiteral(a))?.text ?? null;
  }
  return null;
}

const unwrap = (node) => {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)))
    node = node.expression;
  return node;
};

/** The `.map` callback applied to a tuple table, directly or through a named variable. */
function mapCallback(table) {
  let node = table;
  while (ts.isParenthesizedExpression(node.parent) || ts.isAsExpression(node.parent))
    node = node.parent;
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name.text === 'map')
    return parent.parent.arguments?.[0] ?? null;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    let found = null;
    const name = parent.name.text;
    const visit = (n) => {
      if (
        !found &&
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'map' &&
        ts.isIdentifier(n.expression.expression) &&
        n.expression.expression.text === name
      )
        found = n.arguments[0] ?? null;
      ts.forEachChild(n, visit);
    };
    let scope = parent;
    while (scope && !ts.isBlock(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
    if (scope) visit(scope);
    return found;
  }
  return null;
}

/** `[[secondary, address, name], ...].map((...) => ({...execute}) | [..., handler])` tables. */
function mappedHandler(literal) {
  const tuple = literal.parent;
  if (!ts.isArrayLiteralExpression(tuple) || !ts.isArrayLiteralExpression(tuple.parent))
    return null;
  const callback = mapCallback(tuple.parent);
  if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)))
    return null;
  let body = unwrap(callback.body);
  if (ts.isBlock(body)) {
    const returned = body.statements.find((st) => ts.isReturnStatement(st));
    body = unwrap(returned?.expression);
  }
  if (!body) return null;
  if (ts.isObjectLiteralExpression(body)) return handlerOf(body);
  if (ts.isArrayLiteralExpression(body))
    return (
      body.elements.find(
        (e) => ts.isArrowFunction(e) || ts.isFunctionExpression(e) || ts.isCallExpression(e),
      ) ?? null
    );
  return null;
}

/** `handlers[secondary]` where `handlers` is an object literal keyed by secondary. */
function keyedHandler(access, key) {
  if (key === null || !ts.isIdentifier(access.expression)) return null;
  const name = access.expression.text;
  for (let scope = access.parent; scope; scope = scope.parent) {
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
    for (const statement of scope.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.name.getText() !== name) continue;
        let init = declaration.initializer;
        while (init && ts.isAsExpression(init)) init = init.expression;
        if (!init || !ts.isObjectLiteralExpression(init)) return null;
        for (const property of init.properties)
          if (property.name && Number(property.name.getText()) === key)
            return ts.isPropertyAssignment(property) ? property.initializer : property;
        // `handlers[0x00] = (h) => ...` assignments later in the same scope.
        for (const later of scope.statements) {
          if (!ts.isExpressionStatement(later) || !ts.isBinaryExpression(later.expression))
            continue;
          const {left, right, operatorToken} = later.expression;
          if (
            operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isElementAccessExpression(left) &&
            left.expression.getText() === name &&
            numericLiteral(left.argumentExpression) === key
          )
            return right;
        }
        return null;
      }
    }
  }
  return null;
}

function findDefinitions(files, addresses) {
  /** address -> {name, handler, file} */
  const found = new Map();
  for (const source of files) {
    const visit = (node) => {
      if (ts.isNumericLiteral(node) && addresses.has(Number(node.text))) {
        const address = Number(node.text);
        let owner = node.parent;
        if (ts.isPropertyAssignment(owner)) owner = owner.parent;
        let handler = null,
          name = null;
        if (ts.isObjectLiteralExpression(owner) || ts.isCallExpression(owner)) {
          handler = handlerOf(owner);
          name = nameOf(owner, node);
        } else if (ts.isArrayLiteralExpression(owner)) {
          // [secondary, nativeAddress, 'Name', handler?] tuples.
          name = owner.elements.find((e) => ts.isStringLiteral(e))?.text ?? null;
          handler =
            owner.elements.find((e) => ts.isArrowFunction(e) || ts.isFunctionExpression(e)) ?? null;
        }
        if (handler === null) {
          handler = mappedHandler(node);
          if (handler && ts.isNonNullExpression(handler)) handler = handler.expression;
          if (handler && ts.isElementAccessExpression(handler))
            handler = keyedHandler(handler, numericLiteral(owner.elements?.[0]));
        }
        if (handler !== null && !found.has(address))
          found.set(address, {name, handler, file: relative(REPO, source.fileName)});
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

// ---------------------------------------------------------------------------

function identifier(name, primary, secondary) {
  const fallback = `native_${hex(primary)}_${hex(secondary)}`;
  if (!name) return fallback;
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : fallback;
}

const hex = (value) => value.toString(16).padStart(2, '0');

export function collectNatives() {
  const files = walkFiles(BURIKO).map(parse);
  const analyzer = new EffectAnalyzer(files);
  const inventories = REVISIONS.map((r) => ({
    ...r,
    slots: readInventory(r.inventory, r.table),
    primarySlots: readInventory(r.inventory, r.primaries),
  }));
  const addresses = new Set();
  for (const {slots} of inventories)
    for (const bank of slots.values()) for (const address of bank.values()) addresses.add(address);
  const definitions = findDefinitions(files, addresses);
  const reference = inventories[0].slots;
  const result = {};
  for (const inventory of inventories) {
    const natives = [];
    for (const [primary, bank] of [...inventory.slots].sort((a, b) => a[0] - b[0])) {
      for (const [secondary, address] of [...bank].sort((a, b) => a[0] - b[0])) {
        const definition =
          definitions.get(address) ?? definitions.get(reference.get(primary)?.get(secondary));
        const effect = definition ? analyzer.handler(definition.handler) : UNKNOWN;
        natives.push({
          primary,
          secondary,
          nativeAddress: `0x${address.toString(16)}`,
          name: identifier(definition?.name, primary, secondary),
          pops: effect.pops === null ? null : effect.pops.length,
          pushes: effect.pushes,
          // Argument kinds in push order: the first popped cell is the last argument.
          params: effect.pops === null ? null : effect.pops.map((pop) => pop.kind).reverse(),
          source: definition?.file ?? null,
        });
      }
    }
    const primaries = [...inventory.primarySlots.keys()].sort((a, b) => a - b);
    result[inventory.id] = {revision: inventory.revision, primaries, natives};
  }
  return result;
}

// ---------------------------------------------------------------------------
// SLEIGH generation

/** Operand-stack register file size; slot indices wrap within it. */
export const SLOTS = 256;
export const MAX_POP = 40;
export const MAX_PUSH = 3;
export const MAX_ARGS = 32;
export const MAX_RESULTS = 8;
export const MAX_STORE_SEQUENCE = 32;

const header = (what) =>
  `# ${what}\n# Generated by tools/ghidra-bgi/generate-sleigh.mjs. Do not edit.\n\n`;

/** A subtable exporting the operand-stack register at a context-derived index. */
function slot(name, expression) {
  const local = `${name.toLowerCase()}off`;
  return `${name}: ${local} is sd & cn & fm [ ${local} = 0x1000 + ((${expression}) & ${SLOTS - 1}) * 4; ] { export *[register]:4 ${local}; }`;
}

/** Register file, slot subtables, call marshalling and fixed-count stores. */
export function stackSleigh() {
  const out = [header('Operand-stack register file and call marshalling.')];
  const names = (prefix, count) => Array.from({length: count}, (_, i) => `${prefix}${i}`).join(' ');
  out.push(`define register offset=0x1000 size=4 [ ${names('S', SLOTS)} ];`);
  out.push(`define register offset=0x0800 size=4 [ ${names('P', MAX_ARGS)} ];`);
  out.push(`define register offset=0x0900 size=4 [ ${names('R', MAX_RESULTS)} ];`);
  out.push('');
  out.push('# T1 is the top of the operand stack before the instruction; Qn are cells above it.');
  for (let i = 1; i <= MAX_POP; i++) out.push(slot(`T${i}`, `sd - ${i}`));
  for (let i = 0; i < MAX_PUSH; i++) out.push(slot(`Q${i}`, `sd + ${i}`));
  out.push('');
  // Repeated-operand cells, one constructor per repeat index (see PLIST in bgi.sinc).
  for (let i = 0; i < SLOTS; i++)
    out.push(
      `PS: psoff is sd & ri=${i} [ psoff = 0x1000 + ((sd + ${i} - 1) & ${SLOTS - 1}) * 4; ] { export *[register]:4 psoff; }`,
    );
  for (let i = 0; i < SLOTS; i++)
    out.push(
      `ES: esoff is sd & ri=${i} [ esoff = 0x1000 + ((sd - ${i}) & ${SLOTS - 1}) * 4; ] { export *[register]:4 esoff; }`,
    );
  out.push('');
  // Calls: arguments are the cn cells below an optional popped target (indirect = 1).
  for (const [suffix, extra] of [
    ['', 0],
    ['I', 1],
  ]) {
    for (let i = 0; i < MAX_ARGS - 1; i++)
      out.push(slot(`A${suffix}${i}`, `sd - ${extra} - cn + ${i}`));
    for (let k = 0; k < MAX_ARGS; k++) {
      const operands = Array.from({length: k}, (_, i) => `A${suffix}${i}`);
      const body = operands.map((a, i) => `P${i} = ${a};`).join(' ');
      out.push(`ARGS${suffix}: is cn=${k}${operands.map((o) => ` & ${o}`).join('')} { ${body} }`);
    }
    for (let k = 0; k < MAX_RESULTS; k++) {
      const operands = Array.from({length: k}, (_, i) => `A${suffix}${i}`);
      const body = operands.map((a, i) => `${a} = R${i};`).join(' ');
      out.push(`RETS${suffix}: is cm=${k}${operands.map((o) => ` & ${o}`).join('')} { ${body} }`);
    }
    out.push('');
  }
  // Formatted text: T1 format, T2 destination, then one cell per conversion.
  for (let k = 0; k <= MAX_POP - 2; k++) {
    const operands = Array.from({length: k}, (_, i) => `T${i + 3}`);
    out.push(
      `FMT: is cn=${k} & T1 & T2${operands.map((o) => ` & ${o}`).join('')} { format_text(T2, T1${operands.map((o) => `, ${o}`).join('')}); }`,
    );
  }
  out.push('');
  // Function entry copies parameters into the cells below the entry depth.
  for (let k = 0; k < MAX_ARGS; k++) {
    const body = Array.from({length: k}, (_, i) => `S${i} = P${i};`).join(' ');
    out.push(`ENTRY: is fn=${k} { ${body} }`);
  }
  // Return copies the fm cells on top of the stack into result registers.
  for (let i = 0; i < MAX_RESULTS - 1; i++) out.push(slot(`V${i}`, `sd - fm + ${i}`));
  for (let k = 0; k < MAX_RESULTS; k++) {
    const operands = Array.from({length: k}, (_, i) => `V${i}`);
    out.push(
      `RETV: is fm=${k}${operands.map((o) => ` & ${o}`).join('')} { ${operands.map((v, i) => `R${i} = ${v};`).join(' ')} }`,
    );
  }
  out.push('');
  // Fixed-count scalar sequences (0c): values[count-1-i] is stored at address + i * width.
  const widths = [1, 2, 4];
  for (let type = 0; type < 3; type++) {
    const w = widths[type];
    for (let k = 0; k <= MAX_STORE_SEQUENCE; k++) {
      const operands = Array.from({length: k + 1}, (_, i) => `T${i + 1}`);
      const stores = Array.from(
        {length: k},
        (_, i) => `*[ram]:${w} (T${k + 1} + ${i * w}) = T${k - i}${w === 4 ? '' : `:${w}`};`,
      ).join(' ');
      out.push(
        `:store.seq.${w} "${k}" is op=0x0c; stt=${type}; cnt=${k}${operands.map((o) => ` & ${o}`).join('')} { ${stores} }`,
      );
    }
  }
  out.push('');
  return out.join('\n') + '\n';
}

/** Native slots are called as stub functions at NATIVE_BASE + primary * 0x400 + secondary * 4. */
export const NATIVE_BASE = 0xf0000000;

/**
 * One SLEIGH constructor per native slot. Known effects move the popped cells into P0..,
 * call the slot's stub function and push R0..; unknown effects use the analyzer's counts.
 */
export function nativeSleigh(revision, natives) {
  const out = [header(`Native slots of BGI ${revision}.`)];
  const banks = [...new Set(natives.map((n) => n.primary))];
  for (const bank of banks) {
    const base = `0x${(NATIVE_BASE + bank * 0x400).toString(16)}`;
    out.push(`NS${hex(bank)}: addr is sec [ addr = ${base} + sec * 4; ] { export *[ram]:4 addr; }`);
  }
  out.push('');
  for (const n of natives) {
    const stub = `NS${hex(n.primary)}`;
    const pattern = `op=0x${hex(n.primary)}; sec=0x${hex(n.secondary)} & ${stub}`;
    if (n.pops === null || n.pushes === null) {
      out.push(
        `:${n.name} is ${pattern} & ARGS & RETS { build ARGS; ra = inst_next; call ${stub}; build RETS; }`,
      );
      continue;
    }
    const k = n.pops;
    // Popped cells T1 (top) .. Tk; the deepest is the first argument.
    const args = Array.from({length: k}, (_, i) => `T${k - i}`);
    const results = Array.from({length: n.pushes}, (_, j) => (j < k ? `T${k - j}` : `Q${j - k}`));
    const operands = [...new Set([...args, ...results])];
    const body = [
      ...args.map((cell, i) => `P${i} = ${cell};`),
      'ra = inst_next;',
      `call ${stub};`,
      ...results.map((cell, j) => `${cell} = R${j};`),
    ].join(' ');
    out.push(`:${n.name} is ${pattern}${operands.map((o) => ` & ${o}`).join('')} { ${body} }`);
  }
  return out.join('\n') + '\n';
}

/** The native table read by the Java analyzer: one slot per line. */
export function nativeJson(revision, primaries, natives) {
  const lines = natives.map((n) => `    ${JSON.stringify(n)}`);
  return `{
  "schema": "bgi-native-slots/v1",
  "revision": ${JSON.stringify(revision)},
  "primaries": ${JSON.stringify(primaries)},
  "natives": [
${lines.join(',\n')}
  ]
}
`;
}

/** Compiler spec: frame bank as a positive-growth stack, parameters/results in registers. */
export function compilerSpec() {
  const registers = (prefix, count, indent) =>
    Array.from({length: count}, (_, i) => `${indent}<register name="${prefix}${i}"/>`).join('\n');
  const entries = (prefix, count) =>
    Array.from(
      {length: count},
      (_, i) => `        <pentry minsize="1" maxsize="4"><register name="${prefix}${i}"/></pentry>`,
    ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by tools/ghidra-bgi/generate-sleigh.mjs. Do not edit. -->
<compiler_spec>
  <data_organization>
    <absolute_max_alignment value="0"/>
    <machine_alignment value="1"/>
    <default_alignment value="1"/>
    <default_pointer_alignment value="1"/>
    <pointer_size value="4"/>
    <char_type signed="true"/>
    <char_size value="1"/>
    <wchar_size value="2"/>
    <short_size value="2"/>
    <integer_size value="4"/>
    <long_size value="4"/>
    <long_long_size value="8"/>
  </data_organization>
  <global>
    <range space="ram"/>
  </global>
  <stackpointer register="fp" space="ram" growth="positive"/>
  <returnaddress>
    <register name="ra"/>
  </returnaddress>
  <default_proto>
    <prototype name="__bgi" extrapop="0" stackshift="0" strategy="register">
      <input>
${entries('P', MAX_ARGS)}
      </input>
      <output>
        <pentry minsize="1" maxsize="4"><register name="R0"/></pentry>
      </output>
      <unaffected>
        <register name="fp"/>
${registers('S', SLOTS, '        ')}
      </unaffected>
      <killedbycall>
${registers('R', MAX_RESULTS, '        ')}
${registers('P', MAX_ARGS, '        ')}
        <register name="ra"/>
        <register name="tA"/>
        <register name="tV"/>
        <register name="tL"/>
        <register name="tR"/>
      </killedbycall>
    </prototype>
  </default_proto>
</compiler_spec>
`;
}

/** Every generated language file, keyed by file name. */
export function generatedFiles(tables = collectNatives()) {
  const files = new Map([
    ['bgi_stack.sinc', stackSleigh()],
    ['bgi.cspec', compilerSpec()],
  ]);
  for (const [id, {revision, primaries, natives}] of Object.entries(tables)) {
    files.set(`bgi_natives_${id}.json`, nativeJson(revision, primaries, natives));
    files.set(`bgi_natives_${id}.sinc`, nativeSleigh(revision, natives));
  }
  return files;
}

/** Writes the generated files into `directory` and returns per-revision counts. */
export function generate(directory) {
  const tables = collectNatives();
  mkdirSync(directory, {recursive: true});
  for (const [name, text] of generatedFiles(tables)) writeFileSync(join(directory, name), text);
  return Object.values(tables).map(({revision, natives}) => ({
    revision,
    slots: natives.length,
    unknown: natives.filter((n) => n.pops === null || n.pushes === null).length,
    undefined: natives.filter((n) => n.source === null).length,
  }));
}

function main(args) {
  const index = args.indexOf('--out');
  if (index < 0 || !args[index + 1]) throw new Error('Usage: generate-sleigh.mjs --out DIR');
  for (const r of generate(args[index + 1]))
    console.log(
      `${r.revision}: ${r.slots} slots, ${r.unknown} with unknown stack effects, ${r.undefined} without a definition`,
    );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main(process.argv.slice(2));
