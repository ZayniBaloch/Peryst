/* ScopeKeep landing - demo terminal + copy button */
(() => {
  const out = document.getElementById('term-out');
  if (!out) return;

  const OUTPUTS = {
    init: [
      ['', '$ npx scopekeep@latest init --mcp=vscode', 'c-blue'],
      ['600', '\u2713 Workspace boundary locked to this repository root', 'c-green'],
      ['300', '\u2713 Encrypted database initialized at ~/.scopekeep/workspaces/', 'c-green'],
      ['300', '\u2713 Ed25519 evidence keypair generated', 'c-green'],
      ['300', '\u2713 .vscode/mcp.json written (stdio, portable ${workspaceFolder})', 'c-green'],
      ['500', '', ''],
      ['0', 'ScopeKeep MCP server ready. Your editor will ask you to trust it.', 'c-orange']
    ],
    save: [
      ['', '// tool call from your agent: add_memory', 'c-dim'],
      ['400', '{', 'c-pink'],
      ['80', '  "content": "Deployments must run pnpm build --filter=web first",', 'c-pink'],
      ['80', '  "agent_id": "claude-code"', 'c-pink'],
      ['200', '}', 'c-pink'],
      ['350', '', ''],
      ['0', '\u2713 Memory #41 stored \u00b7 summary: "Deploy web filter first" \u00b7 ns: shared', 'c-green']
    ],
    search: [
      ['', '// tool call: search_memories("how do we deploy the web app?")', 'c-dim'],
      ['450', '#41  Deployments must run pnpm build --filter=web first   sim 0.91', ''],
      ['120', '#17  Never deploy on Fridays \u2014 freeze window policy           sim 0.74', ''],
      ['120', '#8   CDN cache purge takes ~2min after each release           sim 0.71', ''],
      ['400', '', ''],
      ['0', '\u2713 Attestation a-9f3e\u2026 signed \u00b7 chain head verified', 'c-green']
    ],
    verify: [
      ['', '// tool call: verify_attestation("a-9f3e\u2026")', 'c-dim'],
      ['500', '{', 'c-pink'],
      ['80', '  "valid": true,', 'c-pink'],
      ['80', '  "signature": "ed25519 \u2713",', 'c-pink'],
      ['80', '  "hash_chain": "\u2713 linked to previous entry",', 'c-pink'],
      ['80', '  "query": "<hashed>", "memories_returned": [41, 17, 8]', 'c-pink'],
      ['150', '}', 'c-pink'],
      ['350', '', ''],
      ['0', 'Evidence holds: what was returned, when, and to which agent.', 'c-orange']
    ]
  };

  let token = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function play(cmd) {
    const my = ++token;
    out.textContent = '';
    out.classList.add('cursor-blink');
    for (const [delay, text, cls] of OUTPUTS[cmd]) {
      if (my !== token) return;
      if (delay) await sleep(delay);
      if (my !== token) return;
      if (!text) { out.appendChild(document.createElement('br')); continue; }
      const line = document.createElement('span');
      if (cls) line.className = cls;
      line.textContent = text + '\n';
      out.appendChild(line);
    }
  }

  document.querySelectorAll('.preset').forEach((b) =>
    b.addEventListener('click', () => play(b.dataset.cmd))
  );
  play('init');

  const copyBtn = document.getElementById('copy-install');
  const snippet = document.getElementById('install-snippet');
  if (copyBtn && snippet) {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(snippet.innerText);
        copyBtn.textContent = 'Copied';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1400);
      } catch (_) {}
    });
  }
})();
