#!/usr/bin/env node

/**
 * ScopeKeep workspace rules generator and editor configuration builder.
 * 
 * Usage:
 *   npx scopekeep init
 *   npx scopekeep init --mcp vscode,cursor
 *   npx scopekeep init --mcp=vscode,cursor
 * 
 * What it does:
 *   1. Safely creates or appends system instructions to `.cursorrules` and `.windsurfrules`
 *   2. Creates a general `.scopekeeprules.md` workspace guide
 *   3. Configures Git post-commit hook for auto-ingestion
 *   4. Generates cryptographic Ed25519 keys for signed retrieval evidence
 *   5. Detects and configures VS Code, Cursor, Aider, Claude Code, and Continue
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join, resolve, dirname, basename } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { initializeKeys } from '../src/attestation.js';
import { updateWorkspaceRules } from '../src/rules-updater.js';
import { autoRepoIngest } from '../src/repo-ingest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_DIR = join(homedir(), '.scopekeep');

// ============================================================
// SYSTEM INSTRUCTION CONTENT
// ============================================================

const INSTRUCTION_HEADER = '# ScopeKeep Memory Integration';

const RULE_CONTENT = `
${INSTRUCTION_HEADER}
You are integrated with ScopeKeep, a local-first MCP memory server that stores user preferences, project guidelines, context, and decisions.

## Active Context (CRITICAL)
Always check this section first before making any tool calls. If the information you need is already listed here, do NOT call search_memories or get_optimized_context (this saves token budget and avoids roundtrips).
<!-- PERSYST_CONTEXT_START -->
<!-- PERSYST_CONTEXT_END -->

## Proactive Memory Retrieval
- If the required context is NOT found in the Active Context section above, invoke the \`scopekeep\` MCP server's \`search_memories\` or \`get_optimized_context\` tool.
- Extract relevant search terms from the user's prompt (e.g. if the user says "update the database schema", query "database", "schema", "sqlite", "table").
- Provide your agent name (e.g. \`cursor-agent\`, \`roo-code\`, \`antigravity-worker\`) as the \`agent_id\` parameter when searching to query your private namespace + shared project context.

## Proactive Memory Storage (CRITICAL)
- Record Milestones: When you successfully implement a feature, fix a bug, or make an architectural decision, call the \`add_memory\` tool to store a summary of the change.
- Agentic Swarms & Namespaces: If you are part of a multi-agent swarm or need private partition, pass your agent name as \`agent_id\` and set \`shared: false\` to store private memories. For general project guidelines and files, leave \`shared: true\` (default) so other agents can access them.
- Handle Contradictions: ScopeKeep handles contradiction detection automatically. If a new fact contradicts an old memory, ScopeKeep will flag it.
- Quality Over Quantity: Do NOT store trivial facts, temporary conversation noise, or duplicate data. "Bad data is worse than no data". Only store long-term architecture decisions, project details, and explicit user preferences.

## Explicit User Save Requests
- If the user explicitly asks you to remember, save, or keep a note of a fact (e.g., "Remember that John handles deployment", "remind me that staging is flaky"), call the \`add_memory\` tool immediately with that content.
- Bypassing Tech Filters: Explicit user requests bypass the programming keyword filters. Ensure they are captured verbatim.

## Mandatory Completion Checklist (HARD CONSTRAINT)
Before writing your final response declaring a task, feature, or bug fix complete:
1. Ask yourself: "Did I implement a feature, fix a bug, configure a tool, or discover a project rule?"
2. If YES: Call the \`add_memory\` tool to store the milestone as your final tool call *before* writing your final message to the user.
3. If NO: You may proceed to conclude without saving.
Never rely on the user to remind you to save milestones.
`;

const GENERAL_GUIDE = `# ScopeKeep Agent Integration Guide

This workspace is configured with the ScopeKeep local-first memory server.

## How to Configure the MCP Server in VS Code / Cursor / Antigravity

Add the following configuration to your IDE's MCP Server settings:

- **Server Name:** \`scopekeep\`
- **Type:** \`command\`
- **Command:** \`npx\`
- **Arguments:** \`["-y", "scopekeep"]\`

Alternatively, if you have installed the package globally (\`npm install -g scopekeep\`), you can configure:
- **Command:** \`scopekeep\`
- **Arguments:** \`[]\`

---

## Copy-Paste System Prompt Instructions
If your agent does not read \`.cursorrules\` or \`.windsurfrules\` natively, copy and paste the following prompt into the agent's Custom Instructions, System Prompt, or System Rules:

\`\`\`markdown
${RULE_CONTENT.trim()}
\`\`\`
`;

// ============================================================
// WORKSPACE HELPERS
// ============================================================

function setupRuleFile(filePath, fileName) {
  let content = RULE_CONTENT;
  let action = 'Created';

  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf8');
    if (existing.includes(INSTRUCTION_HEADER)) {
      console.log(`     [SKIP] ${fileName} already has ScopeKeep rules configured.`);
      return;
    }
    content = existing + '\n' + RULE_CONTENT;
    action = 'Appended to';
  }

  writeFileSync(filePath, content.trim() + '\n', 'utf8');
  console.log(`     [OK] ${action} ${fileName}`);
}

// ============================================================
// GLOBAL CONFIG WRITERS
// ============================================================

function detectEditors() {
  const editors = [];
  const home = homedir();

  // Visual Studio Code
  try {
    execSync('code --version', { stdio: 'ignore' });
    editors.push('vscode');
  } catch (_) {
    const vscodePaths = [
      join(home, 'AppData', 'Local', 'Programs', 'Microsoft VS Code'),
      'C:\\Program Files\\Microsoft VS Code',
      '/Applications/Visual Studio Code.app',
    ];
    if (vscodePaths.some(path => existsSync(path))) editors.push('vscode');
  }
  
  // Cursor
  const cursorDir = join(home, '.cursor');
  const winCursorDir = join(home, 'AppData', 'Roaming', 'Cursor');
  if (existsSync(cursorDir) || existsSync(winCursorDir) || existsSync('/Applications/Cursor.app') || existsSync(join(home, 'AppData', 'Local', 'Programs', 'cursor'))) {
    editors.push('cursor');
  }
  
  // Aider
  try {
    execSync('aider --version', { stdio: 'ignore' });
    editors.push('aider');
  } catch (_) {}
  
  // Claude Code
  const claudeDir = join(home, '.claude');
  if (existsSync(claudeDir) || existsSync('/Applications/Claude Code.app')) {
    editors.push('claude-code');
  }
  
  // Continue.dev
  const continueConfig = join(home, '.continue', 'config.json');
  if (existsSync(continueConfig)) {
    editors.push('continue');
  }

  // Gemini/Antigravity IDE
  const geminiDir = join(home, '.gemini');
  if (existsSync(geminiDir)) {
    editors.push('gemini');
  }
  
  return editors;
}

function getServerConfig(projectName, workspaceRoot, portable = false) {
  const isDevMode = existsSync(join(dirname(__dirname), '.git'));
  const env = {
    PERSYST_PROJECT: projectName,
    SCOPEKEEP_WORKSPACE_ROOT: portable ? '${workspaceFolder}' : workspaceRoot,
  };

  if (isDevMode) {
    const localEntry = portable
      ? '${workspaceFolder}/index.js'
      : resolve(dirname(__dirname), 'index.js').replace(/\\/g, '/');
    return {
      type: 'stdio',
      command: 'node',
      args: [localEntry],
      env,
    };
  }

  return {
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'scopekeep'],
    env,
  };
}

export function writeVSCodeConfig(projectName, workspaceRoot) {
  const vscodeMcp = join(workspaceRoot, '.vscode', 'mcp.json');
  try {
    const config = existsSync(vscodeMcp) ? JSON.parse(readFileSync(vscodeMcp, 'utf8')) : {};
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('existing .vscode/mcp.json must contain a JSON object');
    }
    config.servers = config.servers || {};
    if (typeof config.servers !== 'object' || Array.isArray(config.servers)) {
      throw new Error('existing .vscode/mcp.json "servers" must be an object');
    }
    config.servers.scopekeep = getServerConfig(projectName, workspaceRoot, true);
    mkdirSync(dirname(vscodeMcp), { recursive: true });
    writeFileSync(vscodeMcp, JSON.stringify(config, null, 2) + '\n', 'utf8');
    console.log('     [OK] VS Code MCP config written to .vscode/mcp.json');
    console.log('     [Note] VS Code will ask you to trust the local server before first start.');
  } catch (err) {
    console.error(`     [ERROR] Failed to configure VS Code: ${err.message}`);
  }
}

export function parseRequestedEditors(args) {
  const mcpEquals = args.find(arg => arg.startsWith('--mcp='));
  const mcpIndex = args.indexOf('--mcp');
  const mcpValue = mcpEquals
    ? mcpEquals.slice('--mcp='.length)
    : (mcpIndex >= 0 ? args[mcpIndex + 1] : '');
  return mcpValue
    ? mcpValue.split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
    : [];
}

function writeCursorConfig(projectName, workspaceRoot) {
  const cursorMcp = join(homedir(), '.cursor', 'mcp.json');
  try {
    const config = existsSync(cursorMcp) ? JSON.parse(readFileSync(cursorMcp, 'utf8')) : {};
    config.mcpServers = config.mcpServers || {};
    config.mcpServers.scopekeep = getServerConfig(projectName, workspaceRoot);
    mkdirSync(dirname(cursorMcp), { recursive: true });
    writeFileSync(cursorMcp, JSON.stringify(config, null, 2));
    console.log('     [OK] Cursor MCP config written to ~/.cursor/mcp.json');
  } catch (err) {
    console.error(`     [ERROR] Failed to configure Cursor: ${err.message}`);
  }
}

function writeAiderConfig(projectName, workspaceRoot) {
  const aiderYml = join(homedir(), '.aider.conf.yml');
  try {
    let content = '';
    if (existsSync(aiderYml)) {
      content = readFileSync(aiderYml, 'utf8');
    }
    if (!content.includes('name: scopekeep')) {
      const isDevMode = existsSync(join(dirname(__dirname), '.git'));
      if (isDevMode) {
        const localEntry = resolve(dirname(__dirname), 'index.js').replace(/\\/g, '/');
        content += `\n# ScopeKeep MCP integration\nmcp:\n  - name: scopekeep\n    cmd: node\n    args: ["${localEntry}"]\n    env:\n      PERSYST_PROJECT: ${projectName}\n      SCOPEKEEP_WORKSPACE_ROOT: ${workspaceRoot.replace(/\\/g, '/')}\n`;
      } else {
        content += `\n# ScopeKeep MCP integration\nmcp:\n  - name: scopekeep\n    cmd: npx\n    args: ["-y", "scopekeep"]\n    env:\n      PERSYST_PROJECT: ${projectName}\n      SCOPEKEEP_WORKSPACE_ROOT: ${workspaceRoot.replace(/\\/g, '/')}\n`;
      }
      writeFileSync(aiderYml, content);
      console.log('     [OK] Aider MCP config appended to ~/.aider.conf.yml');
    } else {
      console.log('     [SKIP] Aider already has ScopeKeep configured.');
    }
  } catch (err) {
    console.error(`     [ERROR] Failed to configure Aider: ${err.message}`);
  }
}

function writeClaudeCodeConfig(projectName, workspaceRoot) {
  const claudeJson = join(homedir(), '.claude.json');
  try {
    const config = existsSync(claudeJson) ? JSON.parse(readFileSync(claudeJson, 'utf8')) : {};
    config.mcpServers = config.mcpServers || {};
    config.mcpServers.scopekeep = getServerConfig(projectName, workspaceRoot);
    writeFileSync(claudeJson, JSON.stringify(config, null, 2));
    console.log('     [OK] Claude Code MCP config written to ~/.claude.json');
  } catch (err) {
    console.error(`     [ERROR] Failed to configure Claude Code: ${err.message}`);
  }
}

function writeContinueConfig(projectName, workspaceRoot) {
  const continueConfig = join(homedir(), '.continue', 'config.json');
  try {
    const config = existsSync(continueConfig) ? JSON.parse(readFileSync(continueConfig, 'utf8')) : {};
    config.mcpServers = config.mcpServers || [];
    // Replace only ScopeKeep's own entry. Legacy Persyst entries are left for manual migration.
    config.mcpServers = config.mcpServers.filter(s => s.name !== 'scopekeep');
    
    config.mcpServers.push({
      name: 'scopekeep',
      ...getServerConfig(projectName, workspaceRoot)
    });
    mkdirSync(dirname(continueConfig), { recursive: true });
    writeFileSync(continueConfig, JSON.stringify(config, null, 2));
    console.log('     [OK] Continue.dev MCP config written to ~/.continue/config.json');
  } catch (err) {
    console.error(`     [ERROR] Failed to configure Continue.dev: ${err.message}`);
  }
}

function writeGeminiConfig(projectName, workspaceRoot) {
  const geminiConfig = join(homedir(), '.gemini', 'config', 'mcp_config.json');
  try {
    const config = existsSync(geminiConfig) ? JSON.parse(readFileSync(geminiConfig, 'utf8')) : {};
    config.mcpServers = config.mcpServers || {};
    config.mcpServers.scopekeep = getServerConfig(projectName, workspaceRoot);
    mkdirSync(dirname(geminiConfig), { recursive: true });
    writeFileSync(geminiConfig, JSON.stringify(config, null, 2));
    console.log('     [OK] Gemini/Antigravity MCP config written to ~/.gemini/config/mcp_config.json');
  } catch (err) {
    console.error(`     [ERROR] Failed to configure Gemini/Antigravity: ${err.message}`);
  }
}

// ============================================================
// MAIN RUNNER
// ============================================================

async function runSetup() {
  console.log('');
  console.log('  ScopeKeep - Workspace & Editor Setup');
  console.log('  ══════════════════════════════════════');
  console.log('');

  const cwd = process.cwd();
  console.log(`  Target workspace: ${cwd}`);

  // 1. Initialize local configuration folder and attestations
  console.log('  [1/4] Initializing keypairs & DB folders...');
  mkdirSync(CONFIG_DIR, { recursive: true });
  initializeKeys();
  console.log('     [OK] Cryptographic keypairs generated');

  // 2. Local workspace configurations
  console.log('');
  console.log('  [2/4] Initializing workspace rule files...');
  
  const cursorRulesPath = join(cwd, '.cursorrules');
  setupRuleFile(cursorRulesPath, '.cursorrules');

  const windsurfRulesPath = join(cwd, '.windsurfrules');
  setupRuleFile(windsurfRulesPath, '.windsurfrules');

  const clineRulesPath = join(cwd, '.clinerules');
  setupRuleFile(clineRulesPath, '.clinerules');

  const agentsDir = join(cwd, '.agents');
  mkdirSync(agentsDir, { recursive: true });
  const agentsPath = join(agentsDir, 'AGENTS.md');
  setupRuleFile(agentsPath, 'AGENTS.md');

  const cursorRulesDir = join(cwd, '.cursor', 'rules');
  mkdirSync(cursorRulesDir, { recursive: true });
  const mdcContent = `---
description: Proactive memory retrieval and storage using the ScopeKeep local MCP server
globs: *
alwaysApply: true
---
${RULE_CONTENT.trim()}
`;
  writeFileSync(join(cursorRulesDir, 'scopekeep.mdc'), mdcContent, 'utf8');
  console.log('     [OK] Created .cursor/rules/scopekeep.mdc (Cursor Project Rule with alwaysApply: true)');

  const githubDir = join(cwd, '.github');
  mkdirSync(githubDir, { recursive: true });
  const copilotPath = join(githubDir, 'copilot-instructions.md');
  setupRuleFile(copilotPath, '.github/copilot-instructions.md');

  const generalGuidePath = join(cwd, '.scopekeeprules.md');
  writeFileSync(generalGuidePath, GENERAL_GUIDE.trim() + '\n', 'utf8');
  console.log('     [OK] Created .scopekeeprules.md (General Guide)');

  // 3. Clean and build Git post-commit hook
  const gitDir = join(cwd, '.git');
  if (existsSync(gitDir)) {
    const hooksDir = join(gitDir, 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    const postCommitPath = join(hooksDir, 'post-commit');
    const localScopeKeepPath = resolve(__dirname, '..', 'index.js').replace(/\\/g, '/');

    const hookContent = `#!/bin/sh
# ScopeKeep Git Commit Ingestion Hook
# Automatically ingests recent commits into ScopeKeep memory on every commit.

# Local project path fallback for development
LOCAL_PERSYST="${localScopeKeepPath}"

if [ -f "$LOCAL_PERSYST" ]; then
  node "$LOCAL_PERSYST" ingest "$PWD" 5 >/dev/null 2>&1 || true
else
  npx scopekeep ingest "$PWD" 5 >/dev/null 2>&1 || true
fi
`;

    writeFileSync(postCommitPath, hookContent, { mode: 0o755 });
    try {
      chmodSync(postCommitPath, 0o755);
    } catch (_) {}
    console.log('     [OK] Configured Git post-commit hook for auto-ingestion');
  }

  // 4. Global editor configurations
  console.log('');
  console.log('  [3/4] Initializing global IDE configurations...');
  
  const args = process.argv.slice(2);
  const requestedEditors = parseRequestedEditors(args);
  
  const editors = requestedEditors.length > 0 ? requestedEditors : detectEditors();
  console.log(`     Detected editors/environments: ${editors.join(', ') || 'none'}`);

  const projectName = basename(cwd);

  if (editors.includes('vscode') || editors.includes('vs-code')) writeVSCodeConfig(projectName, cwd);
  if (editors.includes('cursor')) writeCursorConfig(projectName, cwd);
  if (editors.includes('aider')) writeAiderConfig(projectName, cwd);
  if (editors.includes('claude-code')) writeClaudeCodeConfig(projectName, cwd);
  if (editors.includes('continue')) writeContinueConfig(projectName, cwd);
  if (editors.includes('gemini')) writeGeminiConfig(projectName, cwd);

  // Perform baseline repo ingestion
  try {
    const ingestRes = await autoRepoIngest(cwd);
    if (ingestRes.added_count > 0) {
      console.log(`     [OK] Baseline repository ingested (${ingestRes.added_count} technical facts extracted from README/package.json/Git)`);
    }
  } catch (_) {}

  // 5. Run initial rules context update
  console.log('');
  console.log('  [4/4] Injecting initial memory context into rules files...');
  try {
    const updateResult = await updateWorkspaceRules(cwd);
    if (updateResult.success) {
      console.log(`     [OK] Injected context into ${updateResult.updated_files} rule file(s)`);
    } else {
      console.log(`     [Note] ${updateResult.message || 'No rules files updated'}`);
    }
  } catch (err) {
    console.log(`     [Warning] Failed to update rules context: ${err.message}`);
  }

  // 6. Final self-test and notes
  console.log('');
  console.log('  ══════════════════════════════════════');
  console.log('  Setup complete: ScopeKeep is configured for this workspace.');
  console.log('');
  console.log('  Next steps:');
  console.log('    1. In VS Code, run "MCP: List Servers" and start ScopeKeep.');
  console.log('    2. Review the configuration and approve the first-run trust prompt.');
  console.log('');
}

export async function run() {
  try {
    await runSetup();
  } catch (err) {
    console.error(`Fatal setup error: ${err.message}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  run();
}
