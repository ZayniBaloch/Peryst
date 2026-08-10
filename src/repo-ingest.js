import { existsSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { insertMemory, insertVector, memoryExists } from './database.js';
import { generateEmbedding } from './embeddings.js';
import { getRecentCommits } from './git.js';

/**
 * Automatically perform baseline repository ingestion for a project according
 * to the Persyst Memory Data Quality Codex.
 * 
 * Extracts atomic facts with standardized prefixes:
 *   - PROJECT SCOPE: ...
 *   - STACK: ...
 *   - ARCHITECTURE: ...
 *   - COMPLIANCE GATES: ...
 *   - KEY BINARIES: ...
 *   - DEPLOYMENT: ...
 * 
 * @param {string} projectPath - Absolute path to the repository
 * @returns {Promise<{success: boolean, added_count: number}>}
 */
export async function autoRepoIngest(projectPath = process.cwd()) {
  let addedCount = 0;
  const projectNs = process.env.PERSYST_PROJECT || basename(projectPath);

  // 1. Ingest package.json metadata, tech stack & key binaries
  const pkgPath = join(projectPath, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (pkg.name && pkg.description) {
        const descFact = `PROJECT SCOPE: ${pkg.name} — ${pkg.description}`;
        if (!memoryExists(descFact, projectNs)) {
          const id = insertMemory(descFact, 1.0, { source_type: 'repo-meta', source_id: 'package.json', confidence: 1.0 }, projectNs);
          const emb = await generateEmbedding(descFact);
          insertVector(id, emb);
          addedCount++;
        }
      }

      // Tech Stack
      const deps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
      const mainStack = deps.filter(d => 
        ['react', 'next', 'vue', 'express', 'better-sqlite3', 'sqlite-vec', 'zod', 'typescript', 'tailwind', 'chokidar', '@huggingface/transformers'].some(tech => d.includes(tech))
      );
      if (mainStack.length > 0) {
        const stackFact = `STACK: Built with ${mainStack.slice(0, 8).join(', ')}`;
        if (!memoryExists(stackFact, projectNs)) {
          const id = insertMemory(stackFact, 1.0, { source_type: 'repo-meta', source_id: 'package.json', confidence: 1.0 }, projectNs);
          const emb = await generateEmbedding(stackFact);
          insertVector(id, emb);
          addedCount++;
        }
      }

      // Key Binaries
      if (pkg.bin && typeof pkg.bin === 'object') {
        const binNames = Object.keys(pkg.bin);
        if (binNames.length > 0) {
          const binFact = `KEY BINARIES: ${binNames.join(', ')} CLI tools`;
          if (!memoryExists(binFact, projectNs)) {
            const id = insertMemory(binFact, 0.9, { source_type: 'repo-meta', source_id: 'package.json', confidence: 1.0 }, projectNs);
            const emb = await generateEmbedding(binFact);
            insertVector(id, emb);
            addedCount++;
          }
        }
      }
    } catch (_) {}
  }

  // 2. Ingest README.md technical facts & compliance gates
  const readmeNames = ['README.md', 'readme.md', 'README.markdown', 'README.txt'];
  let readmePath = null;
  for (const name of readmeNames) {
    const full = join(projectPath, name);
    if (existsSync(full)) {
      readmePath = full;
      break;
    }
  }

  if (readmePath) {
    try {
      const text = readFileSync(readmePath, 'utf8');
      const lines = text.split('\n');
      const facts = [];

      for (let line of lines) {
        line = line.trim();
        const lower = line.toLowerCase();

        // Extract headers
        if (line.startsWith('#') && line.length > 5 && line.length < 120) {
          const header = line.replace(/^#+\s*/, '').trim();
          if (header && !lower.includes('license') && !lower.includes('table of contents')) {
            if (lower.includes('compliance') || lower.includes('security') || lower.includes('hipaa') || lower.includes('gdpr') || lower.includes('soc')) {
              facts.push(`COMPLIANCE GATES: ${header}`);
            } else if (lower.includes('quick start') || lower.includes('setup') || lower.includes('installation')) {
              facts.push(`IDE AUTO-SETUP: ${header}`);
            } else {
              facts.push(`ARCHITECTURE: ${header}`);
            }
          }
        } else if ((line.startsWith('- ') || line.startsWith('* ')) && line.length > 15 && line.length < 160) {
          const bullet = line.replace(/^[-*]\s*/, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim();
          if (bullet && !bullet.startsWith('http') && !bullet.includes('npm install') && !bullet.includes('git clone')) {
            if (lower.includes('compliance') || lower.includes('security') || lower.includes('hipaa') || lower.includes('gdpr') || lower.includes('soc') || lower.includes('audit')) {
              facts.push(`COMPLIANCE GATES: ${bullet}`);
            } else {
              facts.push(`ARCHITECTURE: ${bullet}`);
            }
          }
        }
      }

      // Select top 12 facts
      const selectedFacts = facts.slice(0, 12);
      for (const fact of selectedFacts) {
        if (!memoryExists(fact, projectNs)) {
          const id = insertMemory(fact, 0.9, { source_type: 'repo-readme', source_id: basename(readmePath), confidence: 0.9 }, projectNs);
          const emb = await generateEmbedding(fact);
          insertVector(id, emb);
          addedCount++;
        }
      }
    } catch (_) {}
  }

  // 3. Ingest recent Git commit logs
  try {
    const commits = await getRecentCommits(projectPath, 10);
    for (const c of commits) {
      if (c.importance >= 0.6) {
        const fact = `Git History [${c.hash.slice(0, 7)}]: ${c.message} (${c.date})`;
        if (!memoryExists(fact, projectNs)) {
          const id = insertMemory(fact, c.importance, { source_type: 'git-commit', source_id: c.hash, confidence: 0.9 }, projectNs);
          const emb = await generateEmbedding(fact);
          insertVector(id, emb);
          addedCount++;
        }
      }
    }
  } catch (_) {
    // Non-git directories ignore gracefully
  }

  return { success: true, added_count: addedCount };
}
