#!/usr/bin/env node
import {readFile, realpath} from 'node:fs/promises';
import {resolve, relative, isAbsolute, sep} from 'node:path';
import {emitTypeScript, inspectMcpPcode, resolveRoute, LiftError} from './index.mjs';

const usage =
  'Usage: node tools/native-lift/cli.mjs inspect-pcode DUMP.json | check LEAF.json [REGISTRY.json] | emit LEAF.json [REGISTRY.json]';
try {
  const [command, leafPath, registryPath, ...extra] = process.argv.slice(2);
  if (
    !['inspect-pcode', 'check', 'emit'].includes(command) ||
    !leafPath ||
    extra.length ||
    (command === 'inspect-pcode' && registryPath)
  )
    throw new Error(usage);
  const leaf = JSON.parse(await readFile(leafPath, 'utf8'));
  if (command === 'inspect-pcode')
    process.stdout.write(JSON.stringify(inspectMcpPcode(leaf), null, 2) + '\n');
  else {
    const registry = registryPath ? JSON.parse(await readFile(registryPath, 'utf8')) : undefined;
    const selected = resolveRoute(leaf, registry);
    if (command === 'check') {
      const {values, ...report} = selected;
      process.stdout.write(
        JSON.stringify(
          {
            ...report,
            status: selected.unsupported.length && !selected.route ? 'blocked' : 'prototype-ready',
          },
          null,
          2,
        ) + '\n',
      );
      if (selected.unsupported.length && !selected.route) process.exitCode = 1;
    } else {
      const sources = new Map();
      if (selected.route) {
        const implementation = selected.route.implementation;
        if (isAbsolute(implementation.sourcePath))
          throw new Error('Implementation sourcePath must be relative to the working directory');
        const root = await realpath(process.cwd()),
          path = await realpath(resolve(root, implementation.sourcePath));
        const relativePath = relative(root, path);
        if (
          relativePath === '..' ||
          relativePath.startsWith(`..${sep}`) ||
          isAbsolute(relativePath)
        )
          throw new Error('Implementation sourcePath escapes the working directory');
        sources.set(implementation.id, await readFile(path, 'utf8'));
      }
      process.stdout.write(emitTypeScript(leaf, registry, sources).source);
    }
  }
} catch (error) {
  process.stderr.write(
    JSON.stringify(
      {
        status: 'refused',
        code: error instanceof LiftError ? error.code : 'INPUT',
        message: error.message,
        ...(error instanceof LiftError ? {details: error.details} : {}),
      },
      null,
      2,
    ) + '\n',
  );
  process.exitCode = 1;
}
