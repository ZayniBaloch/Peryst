# ScopeKeep Memory Data Quality Codex

An engineering specification for memory structure, data hygiene, and context injection in **ScopeKeep 3 public alpha**.

---

## 🎯 Core Principles

1. **Atomic Fact Ingestion**: Every memory record MUST represent a single, self-contained technical statement. Multi-sentence narrative paragraphs are rejected in favor of structured atomic key-value facts.
2. **Deterministic Classification Prefixes**: Facts are prefixed with standardized uppercase categories to eliminate ambiguity for downstream LLM reasoning:
   - `PROJECT SCOPE:` High-level purpose and ecosystem boundaries.
   - `STACK:` Core dependencies, runtimes, and libraries.
   - `ARCHITECTURE:` System design, database engine, storage patterns, and cryptographic layers.
   - `COMPLIANCE GATES:` Regulatory standards (SOC 2, HIPAA, GDPR Art 17, EU AI Act Art 13).
   - `KEY BINARIES:` CLI commands and executable tools.
   - `DEPLOYMENT:` Transport mechanisms, MCP stdio/HTTP interfaces, and IDE compatibility.
   - `RECENT MILESTONE:` Version releases, bug fixes, and feature completions.
3. **Structured 3-Tier Prompt Context Injection**: Prompt context injected into IDE rule files (`.cursor/rules/scopekeep.mdc`, `.agents/AGENTS.md`, `.github/copilot-instructions.md`) is organized into 3 explicit categories:
   - `userMemory` (User profile & preferences)
   - `sessionMemory` (Active task state & recent milestones)
   - `repoMemory` (Project scope, stack, architecture, compliance, key binaries)

---

## 📄 JSON Memory Record Schema

```json
{
  "id": 2001,
  "content": "PROJECT SCOPE: ScopeKeep 3 — Local-first, project-scoped MCP memory with hybrid keyword and semantic search for coding agents.",
  "importance_score": 1.0,
  "namespace": "Peryst",
  "created_at": 1784664551,
  "last_accessed": 1784664551,
  "access_count": 1,
  "parent_id": null,
  "valid_until": null,
  "provenance": {
    "source_type": "repo-meta",
    "source_id": "package.json",
    "confidence": 1.0
  }
}
```

---

## ⚡ Token Savings & Context Compression

- **Baseline Without Memory**: Reading `README.md`, `package.json`, compliance manuals, and git log consumes **7,000+ tokens** per new chat turn.
- **Optimized Context Payload**: Pre-loading 10–15 atomic facts consumes **~500 tokens**.
- **Net Token Savings**: **6,500+ tokens saved per chat turn** (~130,000 tokens/week per developer).
