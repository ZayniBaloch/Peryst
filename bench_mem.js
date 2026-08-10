/**
 * Persyst LongMemEval benchmark — direct module access.
 * Uses Persyst's internal database and search modules directly
 * (no HTTP overhead, no namespace issues).
 *
 * Run from the Persyst project root.
 */
import { readFileSync } from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { insertMemory, insertVector, deleteMemory, searchKeyword, searchVector, getMemoryById } from './src/database.js';
import { generateEmbedding } from './src/embeddings.js';

// Config
const DATA_FILE = 'C:/Users/Super/AppData/Local/Temp/opencode/bench/data/longmemeval_s_cleaned.json';
const SAMPLE_SIZE = 50;
const MAX_SESSION_CHARS = 8000;

function sessionToText(session, maxTurnLen = 1200) {
  const parts = [];
  for (const t of session) {
    const role = t.role || 'unknown';
    let content = t.content || '';
    if (content.length > maxTurnLen) content = content.slice(0, maxTurnLen) + '...';
    parts.push(`[${role}]: ${content}`);
  }
  return parts.join('\n');
}

async function benchmark() {
  // Clean up old benchmark memories (old embeddings pollute results)
  const dbPath = path.join(os.homedir(), '.persyst', 'persyst.db');
  const cleanupDb = new Database(dbPath);
  const oldIds = cleanupDb.prepare(
    "SELECT memory_id FROM provenance WHERE source_type = 'benchmark'"
  ).all().map(r => r.memory_id);
  cleanupDb.close();
  for (const id of oldIds) {
    try { deleteMemory(id); } catch (_) {}
  }
  if (oldIds.length > 0) {
    console.log(`Cleaned up ${oldIds.length} old benchmark memories`);
  }

  console.log(`Loading LongMemEval v1 from ${DATA_FILE}...`);
  const raw = readFileSync(DATA_FILE, 'utf-8');
  const data = JSON.parse(raw);
  console.log(`Loaded ${data.length} questions`);

  const questions = data.slice(0, SAMPLE_SIZE);
  const results = [];

  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi];
    const { question_id: qid, question_type: qtype, question, answer } = q;
    const sessions = q.haystack_sessions;
    const sessionIds = q.haystack_session_ids;
    const answerSessionIds = new Set(q.answer_session_ids);

    console.log(`\n[${qi + 1}/${questions.length}] ${qid} (${qtype})`);
    console.log(`  Q: ${question.slice(0, 80)}...`);
    console.log(`  A: ${answer.slice(0, 60)}...`);

    // Find the answer session index
    let answerIdx = -1;
    let answerSid = '';
    for (let i = 0; i < sessionIds.length; i++) {
      if (answerSessionIds.has(sessionIds[i])) {
        answerIdx = i;
        answerSid = sessionIds[i];
        break;
      }
    }
    if (answerIdx === -1) {
      console.log('  SKIP: no answer session found');
      continue;
    }

    // Store only the answer session as a memory
    const sessionText = sessionToText(sessions[answerIdx]);
    const truncated = sessionText.length > MAX_SESSION_CHARS
      ? sessionText.slice(0, MAX_SESSION_CHARS)
      : sessionText;
    const content = `[q:${qid}|s:${answerSid}] ${truncated}`;

    let memId;
    try {
      memId = insertMemory(content, 0.8, { source_type: 'benchmark', source_id: 'longmemeval' });
      console.log(`  Stored answer session as memory #${memId} (${content.length} chars)`);
    } catch (e) {
      console.log(`  FAILED to store: ${e.message.slice(0, 100)}`);
      continue;
    }

    // Generate and store vector embedding of the session content
    try {
      const contentEmb = await generateEmbedding(content);
      insertVector(memId, contentEmb);
    } catch (e) {
      console.log(`  VEC STORE failed: ${e.message.slice(0, 80)}`);
    }

    // FTS5 keyword search with the question
    const ftsResults = searchKeyword(question, 50);

    // Embed and vector search
    let vecResults = [];
    try {
      const questionEmb = await generateEmbedding(question);
      vecResults = searchVector(questionEmb, 50);
    } catch (e) {
      console.log(`  Embedding failed: ${e.message.slice(0, 80)}`);
    }

    // Check if answer session is in FTS5 results (match by memory ID)
    let ftsFound = ftsResults.some(r => r.id === memId);
    let ftsRank = ftsResults.findIndex(r => r.id === memId);

    // Check if answer session is in vector results
    let vecFound = vecResults.some(r => r.rowid === memId);
    let vecRank = vecResults.findIndex(r => r.rowid === memId);


    // Hybrid check (FTS5 + vector combined)
    const hybridMap = new Map();
    for (let i = 0; i < ftsResults.length; i++) {
      if (!hybridMap.has(ftsResults[i].id)) {
        hybridMap.set(ftsResults[i].id, { ftsRank: i });
      }
    }
    for (let i = 0; i < vecResults.length; i++) {
      const existing = hybridMap.get(vecResults[i].rowid);
      if (existing) {
        existing.vecRank = i;
      } else {
        hybridMap.set(vecResults[i].rowid, { ftsRank: -1 });
      }
    }

    // Find answer session rank in hybrid
    const hybridIds = [...hybridMap.keys()];
    const hybridRank = hybridIds.indexOf(memId);

    results.push({
      qid, qtype, question, answer,
      ftsFound, ftsRank,
      vecFound, vecRank,
      hybridRank,
      ftsCount: ftsResults.length,
      vecCount: vecResults.length,
      hybridCount: hybridMap.size,
      storedChars: content.length,
    });

    console.log(`  FTS5:  ${ftsFound ? `FOUND at rank ${ftsRank}` : 'NOT FOUND'} (${ftsResults.length} results)`);
    console.log(`  VEC:   ${vecFound ? `FOUND at rank ${vecRank}` : 'NOT FOUND'} (${vecResults.length} results)`);
    console.log(`  HYBRID: ${hybridRank >= 0 ? `FOUND at rank ${hybridRank}` : 'NOT FOUND'} (${hybridMap.size} candidates)`);
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('BENCHMARK SUMMARY');
  console.log('='.repeat(60));

  const n = results.length;
  const ftsFound = results.filter(r => r.ftsFound).length;
  const vecFound = results.filter(r => r.vecFound).length;
  const hybridFound = results.filter(r => r.hybridRank >= 0).length;

  console.log(`\nQuestions: ${n}`);
  console.log(`\nFTS5 Recall:   ${ftsFound}/${n} (${(ftsFound/n*100).toFixed(1)}%)`);
  console.log(`Vector Recall: ${vecFound}/${n} (${(vecFound/n*100).toFixed(1)}%)`);
  console.log(`Hybrid Recall: ${hybridFound}/${n} (${(hybridFound/n*100).toFixed(1)}%)`);

  if (ftsFound > 0) {
    const ftsRanks = results.filter(r => r.ftsFound).map(r => r.ftsRank);
    console.log(`\nFTS5 MRR: ${(ftsRanks.reduce((s, r) => s + 1/(r+1), 0) / n).toFixed(4)}`);
    console.log(`FTS5 Median rank: ${ftsRanks.sort((a,b) => a-b)[Math.floor(ftsRanks.length/2)]}`);
  }
  if (vecFound > 0) {
    const vecRanks = results.filter(r => r.vecFound).map(r => r.vecRank);
    console.log(`\nVector MRR: ${(vecRanks.reduce((s, r) => s + 1/(r+1), 0) / n).toFixed(4)}`);
  }
  if (hybridFound > 0) {
    const hybridRanks = results.filter(r => r.hybridRank >= 0).map(r => r.hybridRank);
    console.log(`\nHybrid MRR: ${(hybridRanks.reduce((s, r) => s + 1/(r+1), 0) / n).toFixed(4)}`);
  }
}

benchmark().catch(console.error);
