#!/usr/bin/env node

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

const GENERATED_MARKERS = [
  '# ScopeKeep Memory Integration',
  '# Persyst Memory Integration'
];

function isGenerated(content) {
  return GENERATED_MARKERS.some(marker => content.includes(marker));
}

function removeGeneratedFile(filePath, removed) {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, 'utf8');
  if (!isGenerated(content)) return;
  unlinkSync(filePath);
  removed.push(filePath);
}

export function uninstallWorkspace(workspaceRoot = process.cwd()) {
  const removed = [];
  const preserved = [];
  const vscodePath = join(workspaceRoot, '.vscode', 'mcp.json');

  if (existsSync(vscodePath)) {
    const config = JSON.parse(readFileSync(vscodePath, 'utf8'));
    if (config?.servers?.scopekeep) {
      delete config.servers.scopekeep;
      writeFileSync(vscodePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
      removed.push('ScopeKeep server from .vscode/mcp.json');
    }
  }

  removeGeneratedFile(join(workspaceRoot, '.scopekeeprules.md'), removed);
  removeGeneratedFile(join(workspaceRoot, '.cursor', 'rules', 'scopekeep.mdc'), removed);
  removeGeneratedFile(join(workspaceRoot, '.cursor', 'rules', 'persyst.mdc'), removed);

  for (const relative of [
    '.cursorrules',
    '.windsurfrules',
    '.clinerules',
    join('.github', 'copilot-instructions.md'),
    join('.agents', 'AGENTS.md')
  ]) {
    const path = join(workspaceRoot, relative);
    if (existsSync(path) && isGenerated(readFileSync(path, 'utf8'))) {
      preserved.push(relative);
    }
  }

  return { removed, preserved, memories_preserved: true };
}

export function runUninstall() {
  const result = uninstallWorkspace();
  console.log('');
  console.log('ScopeKeep workspace integration removed.');
  for (const item of result.removed) console.log(`REMOVED  ${item}`);
  for (const item of result.preserved) {
    console.log(`REVIEW   ${item} (contains other workspace instructions; not deleted automatically)`);
  }
  console.log('PRESERVED  All workspace memories and privacy exports.');
  console.log('Use `scopekeep purge-workspace --confirm=<workspace-id>` only if you intend to erase data.');
  console.log('');
  return result;
}
