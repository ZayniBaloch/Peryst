#!/usr/bin/env node

/**
 * persyst-aider — Aider wrapper with automatic ScopeKeep memory injection
 * 
 * Usage:
 *   npx persyst-aider [aider-args...]
 * 
 * Examples:
 *   npx persyst-aider --model anthropic/claude-sonnet-4
 *   npx persyst-aider --model openai/gpt-4o --auto-commits
 * 
 * How it works:
 *   1. On startup: connects to ScopeKeep, ingests recent git commits
 *   2. Before each prompt: queries ScopeKeep for relevant memories, prepends context
 *   3. On exit: ingests any new git commits created during the session
 * 
 * Design decisions:
 *   - Only enriches prompts > 15 chars (skip "y", "ok", "/run", etc.)
 *   - Does NOT parse Aider's output (too fragile with ANSI codes, streaming, etc.)
 *   - Passes all args directly to Aider — fully transparent proxy
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIN_PROMPT_LENGTH = 15;
const CWD = process.cwd();

// ============================================================
// MCP CLIENT
// ============================================================

let persystClient = null;

async function connectToScopeKeep() {
  if (persystClient) return persystClient;

  const persystPath = resolve(__dirname, '..', 'index.js');

  const transport = new StdioClientTransport({
    command: 'node',
    args: [scopekeepPath]
  });

  persystClient = new Client({
    name: 'persyst-aider',
    version: '1.0.0'
  });

  await persystClient.connect(transport);
  return persystClient;
}

async function callTool(toolName, args) {
  const client = await connectToScopeKeep();
  const result = await client.callTool({ name: toolName, arguments: args });
  if (result.content && result.content[0] && result.content[0].text) {
    return JSON.parse(result.content[0].text);
  }
  return null;
}

async function closeScopeKeep() {
  if (persystClient) {
    try { await persystClient.close(); } catch (_) {}
    persystClient = null;
  }
}

// ============================================================
// MEMORY FUNCTIONS
// ============================================================

/**
 * Ingest recent git commits from the current directory.
 */
async function ingestGitCommits() {
  try {
    const result = await callTool('ingest_git_commits', {
      repo_path: CWD,
      count: 15
    });
    if (result && result.added > 0) {
      console.error(`[scopekeep] Ingested ${result.added} git commits into memory`);
    }
  } catch (_) {
    // Not a git repo or ScopeKeep unavailable — silent
  }
}

/**
 * Search for memories relevant to the user's prompt.
 * Returns a formatted context string or null.
 */
async function getMemoryContext(prompt) {
  try {
    const result = await callTool('search_memories', {
      query: prompt.slice(0, 200),
      limit: 5,
      agent_id: 'aider'
    });

    if (!result || !result.results || result.results.length === 0) {
      return null;
    }

    const lines = ['[ScopeKeep Memory — auto-retrieved context]'];
    for (const mem of result.results) {
      lines.push(`• ${mem.content}`);
    }
    lines.push('[End Memory]');
    lines.push('');

    return lines.join('\n');
  } catch (_) {
    return null;
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  const aiderArgs = process.argv.slice(2);

  // Check if Aider is available
  console.error('[scopekeep] Starting Aider with ScopeKeep memory...');

  // Step 1: Connect to ScopeKeep and ingest git history
  try {
    await connectToScopeKeep();
    console.error('[scopekeep] Connected to memory server ✓');
    await ingestGitCommits();
  } catch (err) {
    console.error(`[scopekeep] Warning: Could not connect to memory server: ${err.message}`);
    console.error('[scopekeep] Aider will run without memory injection.');
  }

  // Step 2: Spawn Aider as a child process
  const cmd = process.platform === 'win32' ? 'aider.cmd' : 'aider';
  const aider = spawn(cmd, aiderArgs, {
    stdio: ['pipe', 'inherit', 'inherit'],
    cwd: CWD
  });

  // Step 3: Set up stdin interception
  const rl = createInterface({
    input: process.stdin,
    terminal: false
  });

  rl.on('line', async (line) => {
    const trimmed = line.trim();

    // Only enrich prompts that are long enough to be real questions
    if (trimmed.length >= MIN_PROMPT_LENGTH && persystClient) {
      try {
        const context = await getMemoryContext(trimmed);
        if (context) {
          // Prepend memory context to the prompt
          aider.stdin.write(context);
          console.error(`[scopekeep] Injected ${context.split('\n').length - 3} memories`);
        }
      } catch (_) {
        // Memory injection failed — just pass through the original prompt
      }
    }

    // Always forward the original line to Aider
    aider.stdin.write(line + '\n');
  });

  // Handle user Ctrl+C
  process.on('SIGINT', () => {
    aider.kill('SIGINT');
  });

  // Step 4: On Aider exit, ingest any new commits and clean up
  aider.on('close', async (code) => {
    console.error('[scopekeep] Aider session ended. Indexing new commits...');
    await ingestGitCommits();
    await closeScopeKeep();
    process.exit(code || 0);
  });

  // Handle stdin close (user closed terminal)
  rl.on('close', () => {
    aider.stdin.end();
  });
}

main().catch(err => {
  console.error(`[scopekeep] Fatal error: ${err.message}`);
  process.exit(1);
});
