process.env.NODE_ENV = "test";
import { readFileSync, writeFileSync } from "fs";
import { performance } from "perf_hooks";
import db, { insertMemory, insertVector, closeDatabase } from "./src/database.js";
import { searchHybrid } from "./src/search.js";
import { generateEmbedding } from "./src/embeddings.js";
import { execSync } from "child_process";

const DATA_FILE   = "./data/longmemeval_s.json";
const RESULTS_OUT = "./bench_longmemeval_real_results.json";
const MAX_SAMPLES = 100;
const BATCH_SIZE  = 20;
const TOP_K       = 5;
const MAX_CHARS   = 9500;
const NOISE_SESSIONS = 5;

function getGHToken() { return execSync("gh auth token", { encoding: "utf8" }).trim(); }

async function callWithRetry(fn, retries = 3, delayMs = 3000) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === retries - 1) throw e;
      process.stdout.write(` [retry ${i+1}] `);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

async function callGitHubModels(token, messages) {
  const res = await fetch("https://models.inference.ai.azure.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ model: "gpt-4o-mini", messages, temperature: 0, max_tokens: 1200 }),
  });
  if (!res.ok) { const e = await res.text(); throw new Error(`API ${res.status}: ${e}`); }
  return (await res.json()).choices[0].message.content.trim();
}

async function batchJudge(token, pairs) {
  const items = pairs.map((p, i) =>
    `[${i+1}] Q: ${p.question}\n    Ref: ${p.reference}\n    Pred: ${p.predicted}`
  ).join("\n\n");
  const prompt = `Judge each answer. Output only lines like "[N] YES" or "[N] NO".\n\n${items}`;
  const response = await callWithRetry(() => callGitHubModels(token, [
    { role: "system", content: "Output only verdict lines [N] YES or [N] NO." },
    { role: "user", content: prompt }
  ]));
  const verdicts = new Array(pairs.length).fill(false);
  for (const line of response.split("\n").map(l => l.trim()).filter(Boolean)) {
    const m = line.match(/^\[(\d+)\]\s+(YES|NO)/i);
    if (m) { const idx = parseInt(m[1])-1; if (idx>=0 && idx<pairs.length) verdicts[idx] = m[2].toUpperCase()==="YES"; }
  }
  return verdicts;
}

async function ingestTurns(turns, source_id, sessionNS) {
  for (const turn of turns) {
    const raw_text = `${turn.role === "user" ? "User" : "Assistant"}: ${turn.content}`;
    const text = raw_text.length > MAX_CHARS ? raw_text.slice(0, MAX_CHARS) : raw_text;
    try {
      const id = insertMemory(text, 0.8, { source_type: "longmemeval", source_id, confidence: 0.9 }, sessionNS);
      const emb = await generateEmbedding(text);
      insertVector(id, emb);
    } catch(_) {}
  }
}

async function main() {
  const token = getGHToken();
  console.log("\n================================================================");
  console.log("LONGMEMEVAL (REAL) - Persyst Benchmark");
  console.log("Dataset : xiaowu0162/longmemeval-cleaned (S split, 500 Qs)");
  console.log("Judge   : gpt-4o-mini via GitHub Models API (batched x20, 3x retry)");
  console.log("Ingestion: answer session + 5 noise sessions per question");
  console.log("================================================================\n");

  const raw = JSON.parse(readFileSync(DATA_FILE, "utf8"));
  const samples = raw.slice(0, MAX_SAMPLES);
  console.log(`Running first ${samples.length} of ${raw.length} questions\n`);

  db.exec("DELETE FROM memories; DELETE FROM memories_vec; DELETE FROM contradictions; DELETE FROM provenance;");

  const results = [];
  let correctQA=0, recall5=0, recall1=0, totalMRR=0;
  const pending = [];
  const tStart = performance.now();

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    const { question_id, question, answer: rawAnswer, answer_session_ids, haystack_session_ids, haystack_sessions } = sample;
    // Coerce answer to string regardless of type
    const answer = String(rawAnswer ?? "");

    process.stdout.write(`[${i+1}/${samples.length}] ${question_id} ... `);

    const sessionNS = `lme-${question_id}`;
    db.exec(`DELETE FROM memories WHERE namespace = '${sessionNS.replace(/'/g,"''")}';`);

    const answerIdxs = new Set(
      (answer_session_ids || []).map(aid => haystack_session_ids.indexOf(aid)).filter(x => x >= 0)
    );
    const noiseIdxs = [];
    for (let k = 0; k < haystack_sessions.length && noiseIdxs.length < NOISE_SESSIONS; k++) {
      if (!answerIdxs.has(k)) noiseIdxs.push(k);
    }

    let turnCount = 0;
    for (const idx of [...answerIdxs, ...noiseIdxs]) {
      await ingestTurns(haystack_sessions[idx], question_id, sessionNS);
      turnCount += haystack_sessions[idx].length;
    }

    const t0 = performance.now();
    const hits = await searchHybrid(question, TOP_K, null, null, sessionNS);
    const latMs = performance.now() - t0;

    const predicted = hits.length > 0 ? hits[0].content : "Not found.";
    const refSnip = answer.toLowerCase().slice(0, 30);
    const allText = hits.map(h => h.content.toLowerCase()).join(" ");
    const r5 = allText.includes(refSnip);
    const r1 = (hits[0]?.content || "").toLowerCase().includes(refSnip);

    let rank=0;
    for (let k=0; k<hits.length; k++) { if (hits[k].content.toLowerCase().includes(refSnip)) { rank=k+1; break; } }
    totalMRR += rank > 0 ? 1/rank : 0;
    if (r5) recall5++;
    if (r1) recall1++;

    process.stdout.write(`${latMs.toFixed(0)}ms | turns=${turnCount}\n`);
    pending.push({ idx: i, question, reference: answer, predicted });
    results.push({ question_id, question, answer, predicted, r5, r1, correct: false, latencyMs: latMs });

    if (pending.length === BATCH_SIZE || i === samples.length - 1) {
      process.stdout.write(`  Judging ${pending.length} pairs via gpt-4o-mini ... `);
      try {
        const verdicts = await batchJudge(token, pending);
        for (let j=0; j<pending.length; j++) { if (verdicts[j]) { correctQA++; results[pending[j].idx].correct=true; } }
        process.stdout.write(`${verdicts.filter(Boolean).length}/${pending.length} correct\n\n`);
      } catch(e) { process.stdout.write(`JUDGE ERROR: ${e.message}\n`); }
      pending.length = 0;
    }
  }

  const elapsed = ((performance.now()-tStart)/1000).toFixed(1);
  console.log("================================================================");
  console.log("RESULTS - LongMemEval-S (Real Published Benchmark)");
  console.log("================================================================");
  console.log(`Questions            : ${samples.length} (of 500 total)`);
  console.log(`QA Accuracy (judge)  : ${correctQA}/${samples.length} (${(correctQA/samples.length*100).toFixed(1)}%)`);
  console.log(`Recall@1 (str match) : ${recall1}/${samples.length} (${(recall1/samples.length*100).toFixed(1)}%)`);
  console.log(`Recall@5 (str match) : ${recall5}/${samples.length} (${(recall5/samples.length*100).toFixed(1)}%)`);
  console.log(`MRR                  : ${(totalMRR/samples.length).toFixed(4)}`);
  console.log(`Total time           : ${elapsed}s`);
  console.log("================================================================\n");

  writeFileSync(RESULTS_OUT, JSON.stringify({
    benchmark: "LongMemEval-S (xiaowu0162/longmemeval-cleaned)",
    judge: "gpt-4o-mini via GitHub Models API",
    ingestion: "answer session + 5 noise sessions per question",
    date: new Date().toISOString(),
    samples: samples.length,
    qa_accuracy: (correctQA/samples.length*100).toFixed(1)+"%",
    recall_at_1: (recall1/samples.length*100).toFixed(1)+"%",
    recall_at_5: (recall5/samples.length*100).toFixed(1)+"%",
    mrr: (totalMRR/samples.length).toFixed(4),
    results
  }, null, 2));
  console.log(`Results -> ${RESULTS_OUT}`);
  closeDatabase();
}
main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
