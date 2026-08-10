import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import { insertMemory, insertVector, deleteMemory, searchKeyword, getMemoryById } from './src/database.js';
import { generateEmbedding } from './src/embeddings.js';

const DATA_FILE = 'C:/Users/Super/AppData/Local/Temp/opencode/bench/data/longmemeval_s_cleaned.json';
const SAMPLE_SIZE = 15;
const MAX_SESSION_CHARS = 6000;
const GH_TOKEN = 'gh auth token 2>&1';
const API_URL = 'https://models.inference.ai.azure.com/chat/completions';

async function callLLM(messages, model = 'gpt-4o-mini', maxTokens = 256) {
  const { execSync } = await import('child_process');
  const token = execSync('gh auth token', { encoding: 'utf-8' }).trim();
  const body = { model, messages, max_tokens: maxTokens, temperature: 0 };
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LLM ${res.status}: ${errText.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

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
  const dbPath = path.join(os.homedir(), '.persyst', 'persyst.db');
  const cleanupDb = new Database(dbPath);
  const oldIds = cleanupDb.prepare("SELECT memory_id FROM provenance WHERE source_type = 'benchmark'").all().map(r => r.memory_id);
  cleanupDb.close();
  for (const id of oldIds) {
    try { deleteMemory(id); } catch (_) {}
  }
  if (oldIds.length > 0) console.log(`Cleaned up ${oldIds.length} old benchmark memories`);

  console.log('Loading LongMemEval...');
  const raw = readFileSync(DATA_FILE, 'utf-8');
  const data = JSON.parse(raw).slice(0, SAMPLE_SIZE);
  const results = [];

  for (let qi = 0; qi < data.length; qi++) {
    const q = data[qi];
    const { question_id: qid, question_type: qtype, question, answer } = q;
    
    console.log(`\n[${qi+1}/${data.length}] ${qid} (${qtype})`);
    console.log(`  Q: ${question.slice(0, 100)}`);
    console.log(`  Ref: ${answer.slice(0, 80)}`);

    // Find & store answer session
    const sessions = q.haystack_sessions;
    const sessionIds = q.haystack_session_ids;
    const answerSessionIds = new Set(q.answer_session_ids);
    let answerIdx = -1;
    for (let i = 0; i < sessionIds.length; i++) {
      if (answerSessionIds.has(sessionIds[i])) { answerIdx = i; break; }
    }
    if (answerIdx === -1) { console.log('  SKIP'); continue; }

    const sessionText = sessionToText(sessions[answerIdx]);
    const maxLen = MAX_SESSION_CHARS - 20;
    const truncated = sessionText.length > maxLen ? sessionText.slice(0, maxLen) : sessionText;
    const content = `[q:${qid}] ${truncated}`;

    let memId;
    try {
      memId = insertMemory(content, 0.8, { source_type: 'benchmark', source_id: 'longmemeval' });
      console.log(`  Stored memory #${memId}`);
    } catch (e) {
      console.log(`  FAIL: ${e.message.slice(0, 80)}`);
      continue;
    }

    try {
      const emb = await generateEmbedding(content);
      insertVector(memId, emb);
    } catch (e) {
      console.log(`  VEC fail: ${e.message.slice(0, 60)}`);
    }

    // Retrieve top-K sessions (truncated to fit LLM context limit)
    const fts = searchKeyword(question, 3);
    const sessionsContext = fts.map(r => {
      const mem = getMemoryById(r.id);
      if (!mem) return '';
      const c = mem.content.length > 4000 ? mem.content.slice(0, 4000) + '...' : mem.content;
      return `[Session]:\n${c}`;
    }).filter(Boolean).join('\n\n---\n\n');

    const prompt = `You have access to conversations. Answer the user's question based on information found in them.

${sessionsContext}

Question: ${question}

Provide only the answer extracted from the conversations above. If the information is not present, say "Not found".`;

    let llmAnswer = '';
    let correct = false;
    try {
      llmAnswer = await callLLM([{ role: 'user', content: prompt }], 'gpt-4o');
      await new Promise(r => setTimeout(r, 1500));
      console.log(`  LLM: ${llmAnswer.slice(0, 120)}`);

      // Judge: ask LLM if answer matches reference
      const judgePrompt = `Question: ${question}
Reference answer: ${answer}
Proposed answer: ${llmAnswer}

Does the proposed answer correctly answer the question given the reference answer? Reply ONLY with YES or NO.`;
      const judgeResult = await callLLM([{ role: 'user', content: judgePrompt }], 'gpt-4o-mini', 10);
      correct = judgeResult.trim().toUpperCase().startsWith('YES');
      await new Promise(r => setTimeout(r, 1500));
      console.log(`  Judge: ${judgeResult.trim()} → ${correct ? 'CORRECT' : 'WRONG'}`);
    } catch (e) {
      console.log(`  LLM fail: ${e.message.slice(0, 80)}`);
    }

    const found = fts.some(r => r.id === memId);
    const bestRank = fts.findIndex(r => r.id === memId);
    results.push({ qid, qtype, question, answer, llmAnswer, correct, found, bestRank, ftsCount: fts.length });
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('END-TO-END QA RESULTS');
  console.log('='.repeat(60));
  
  const n = results.length;
  const correct = results.filter(r => r.correct).length;
  const retrieved = results.filter(r => r.found).length;
  
  const fts5Top5 = results.filter(r => r.found).length;
  const fts5Top1 = results.filter(r => r.bestRank === 0).length;
  
  console.log(`\nFTS5 recall@5: ${fts5Top5}/${n} (${(fts5Top5/n*100).toFixed(1)}%)`);
  console.log(`FTS5 recall@1: ${fts5Top1}/${n} (${(fts5Top1/n*100).toFixed(1)}%)`);
  console.log(`QA accuracy (gpt-4o): ${correct}/${n} (${(correct/n*100).toFixed(1)}%)`);
  
  const types = [...new Set(results.map(r => r.qtype))];
  for (const t of types.sort()) {
    const group = results.filter(r => r.qtype === t);
    const corr = group.filter(r => r.correct).length;
    console.log(`  ${t}: ${corr}/${group.length} (${(corr/group.length*100).toFixed(1)}%)`);
  }

  // Save results
  writeFileSync('bench_e2e_results.json', JSON.stringify(results, null, 2));
  console.log('\nResults saved to bench_e2e_results.json');
}

benchmark().catch(console.error);
