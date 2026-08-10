import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getOptimizedContext } from './search.js';
import { autoRepoIngest } from './repo-ingest.js';

/**
 * Format retrieved memories into 3-tier Markdown lists (userMemory, sessionMemory, repoMemory)
 * according to the Persyst Memory Data Quality Codex.
 */
function formatMarkdownContext(contextData) {
  const { memories, suggested_actions } = contextData;
  if (!memories || memories.length === 0) {
    return '*No active memories loaded for this project.*';
  }
  
  const tiers = {
    userMemory: [],
    sessionMemory: [],
    repoMemory: []
  };

  for (const m of memories) {
    const c = m.summary || m.content;
    const sourceType = m.provenance?.source_type || '';

    if (/^Preference:/i.test(c) || /^User:/i.test(c) || sourceType === 'user-dialogue' || c.toLowerCase().includes('user is testing')) {
      tiers.userMemory.push(c);
    } else if (
      /^(?:RECENT MILESTONE|Milestone|IDE AUTO-SETUP|Decision):/i.test(c) ||
      c.includes('Implemented') ||
      c.includes('Launch Ready') ||
      c.includes('Integration complete')
    ) {
      tiers.sessionMemory.push(c);
    } else {
      tiers.repoMemory.push(c);
    }
  }

  let md = '';
  if (tiers.userMemory.length > 0) {
    md += `### userMemory\n`;
    for (const item of tiers.userMemory) md += `- ${item}\n`;
    md += '\n';
  }

  if (tiers.sessionMemory.length > 0) {
    md += `### sessionMemory\n`;
    for (const item of tiers.sessionMemory) md += `- ${item}\n`;
    md += '\n';
  }

  if (tiers.repoMemory.length > 0) {
    md += `### repoMemory\n`;
    for (const item of tiers.repoMemory) md += `- ${item}\n`;
    md += '\n';
  }

  if (suggested_actions && suggested_actions.length > 0) {
    md += `### Suggested Actions\n`;
    for (const a of suggested_actions) md += `- ${a}\n`;
    md += '\n';
  }

  return md.trim();
}

/**
 * Scan the workspace for active rules files and inject the latest compiled memory context.
 * Overwrites contents between the <!-- PERSYST_CONTEXT_START --> and <!-- PERSYST_CONTEXT_END --> markers.
 * 
 * @param {string} projectPath - Root directory of the active project
 * @returns {Promise<{success: boolean, updated_files?: number, error?: string, message?: string}>}
 */
export async function updateWorkspaceRules(projectPath = process.cwd()) {
  const ruleFiles = [
    join(projectPath, '.agents', 'AGENTS.md'),
    join(projectPath, '.cursor', 'rules', 'scopekeep.mdc'),
    join(projectPath, '.cursor', 'rules', 'persyst.mdc'),
    join(projectPath, '.github', 'copilot-instructions.md'),
    join(projectPath, '.cursorrules'),
    join(projectPath, '.windsurfrules'),
    join(projectPath, '.clinerules'),
    join(projectPath, '.scopekeeprules.md'),
    join(projectPath, '.persystrules.md')
  ];

  let existingFiles = ruleFiles.filter(f => existsSync(f));
  if (existingFiles.length === 0) {
    return { success: false, message: 'No workspace rule files found to update.' };
  }

  // Retrieve context
  const query = 'project conventions architecture preferences rules stack decisions';
  const maxTokens = 1500;
  const project = process.env.PERSYST_PROJECT || projectPath.replace(/\\/g, '/').split('/').pop();
  
  // Perform automatic repository baseline ingestion (skip during unit tests to avoid side-effects)
  if (process.env.NODE_ENV !== 'test') {
    try {
      await autoRepoIngest(projectPath);
    } catch (_) {}
  }

  let contextData;
  try {
    contextData = await getOptimizedContext(query, maxTokens, null, null, project, null);
  } catch (err) {
    console.error(`[scopekeep-updater] Failed to fetch optimized context: ${err.message}`);
    return { success: false, error: err.message };
  }

  const formattedContext = formatMarkdownContext(contextData);
  const startMarker = '<!-- PERSYST_CONTEXT_START -->';
  const endMarker = '<!-- PERSYST_CONTEXT_END -->';

  let updatedCount = 0;
  for (const file of existingFiles) {
    try {
      const content = readFileSync(file, 'utf8');
      const startIdx = content.indexOf(startMarker);
      const endIdx = content.indexOf(endMarker);

      if (startIdx !== -1 && endIdx !== -1 && startIdx < endIdx) {
        const before = content.substring(0, startIdx + startMarker.length);
        const after = content.substring(endIdx);
        const newContent = `${before}\n${formattedContext}\n${after}`;
        
        if (content !== newContent) {
          writeFileSync(file, newContent, 'utf8');
          updatedCount++;
        }
      }
    } catch (err) {
      console.error(`[scopekeep-updater] Failed to update rules file ${file}: ${err.message}`);
    }
  }

  return { success: true, updated_files: updatedCount };
}
