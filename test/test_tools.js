import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../src/tools.js';
import db, { closeDatabase, getMemoryById, getEntityByName } from '../src/database.js';

let server;
const handlers = {};
const annotations = {};

test.before(() => {
  db.exec('DELETE FROM edges; DELETE FROM entities; DELETE FROM memories_vec; DELETE FROM memories; DELETE FROM memories_fts;');
  server = new McpServer({ name: 'test', version: '1.0.0' });
  
  // Intercept tool registration to capture callbacks for unit testing
  const originalTool = server.tool;
  server.tool = (...args) => {
    const name = args[0];
    handlers[name] = args[args.length - 1];
    annotations[name] = args[args.length - 2];
    return originalTool.call(server, ...args);
  };
  
  registerTools(server);
});

test.after(() => {
  closeDatabase();
});

test('MCP Tools Handlers', async (t) => {
  await t.test('tools expose MCP safety annotations', () => {
    assert.equal(annotations.search_memories.readOnlyHint, true);
    assert.equal(annotations.get_memories_as_of.readOnlyHint, true);
    assert.equal(annotations.search_memories.openWorldHint, false);
    assert.equal(annotations.add_memory.readOnlyHint, false);
    assert.equal(annotations.delete_memory.destructiveHint, true);
    assert.equal(annotations.delete_memory.idempotentHint, true);
  });

  await t.test('get_memories_as_of returns an auditable historical snapshot', async () => {
    const handler = handlers['get_memories_as_of'];
    assert.ok(handler, 'get_memories_as_of handler should be registered');
    const response = await handler({ as_of: Date.now(), limit: 10 });
    const result = JSON.parse(response.content[0].text);
    assert.ok(Array.isArray(result.memories));
    assert.equal(result.as_of_unix_ms > 0, true);
  });

  await t.test('add_memory tool stores memory and vector', async () => {
    const handler = handlers['add_memory'];
    assert.ok(handler, 'add_memory handler should be registered');

    // Add unique memory
    const response = await handler({ content: 'Deduplicated unique memory content', importance: 0.9 });
    const result = JSON.parse(response.content[0].text);
    
    assert.ok(result.success);
    assert.ok(result.id);
    
    // Check if stored in DB
    const memory = getMemoryById(result.id);
    assert.equal(memory.content, 'Deduplicated unique memory content');
    assert.equal(memory.importance_score, 0.9);
  });

  await t.test('add_memory tool prevents duplicate memories and boosts existing', async () => {
    const handler = handlers['add_memory'];
    const content = 'Duplicate-prevention test memory';

    // Add first time
    const res1 = await handler({ content, importance: 0.5 });
    const data1 = JSON.parse(res1.content[0].text);
    
    // Add second time (identical content)
    const res2 = await handler({ content, importance: 0.8 });
    const data2 = JSON.parse(res2.content[0].text);

    // Should return success and the SAME ID
    assert.ok(data2.success);
    assert.equal(data1.id, data2.id, 'Should reuse the existing memory ID');
    assert.ok(data2.message.includes('already exists'));

    // Check that the memory's access count has incremented and importance boosted
    const memory = getMemoryById(data1.id);
    assert.equal(memory.access_count, 1);
    // Initial 0.5 + 0.1 boost = 0.6
    assert.equal(memory.importance_score, 0.6);
  });
});
