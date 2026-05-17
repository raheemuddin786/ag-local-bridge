'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { formatMessagesAsPrompt, parseToolCalls, pruneMessageHistory } = require(
  path.join(__dirname, '..', 'src', 'sidecar', 'raw'),
);

// ─── formatMessagesAsPrompt ───

describe('formatMessagesAsPrompt', () => {
  it('formats simple messages with role labels', () => {
    const messages = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'What is 2+2?' },
    ];
    const prompt = formatMessagesAsPrompt(messages, null);
    assert.ok(prompt.includes('[System]'), 'Should contain [System] label');
    assert.ok(prompt.includes('[User]'), 'Should contain [User] label');
    assert.ok(prompt.includes('You are a helpful assistant.'), 'Should contain system content');
    assert.ok(prompt.includes('What is 2+2?'), 'Should contain user content');
  });

  it('includes tool definitions when tools are provided', () => {
    const messages = [{ role: 'user', content: 'Read a file' }];
    const tools = [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      },
    ];
    const prompt = formatMessagesAsPrompt(messages, tools);
    assert.ok(prompt.includes('Available Tools'), 'Should contain tool header');
    assert.ok(prompt.includes('read_file'), 'Should contain tool name');
    assert.ok(prompt.includes('<tool_call>'), 'Should contain tool_call format instruction');
  });

  it('formats tool call history and tool results', () => {
    const tools = [
      {
        type: 'function',
        function: { name: 'read_file', description: 'Read a file' },
      },
    ];
    const messages = [
      { role: 'system', content: 'You are a coding assistant.' },
      { role: 'user', content: 'Read package.json' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path": "package.json"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', name: 'read_file', content: '{"name": "example"}' },
      { role: 'user', content: 'What is the name field?' },
    ];
    const prompt = formatMessagesAsPrompt(messages, tools);
    assert.ok(prompt.includes('[Tool Result: read_file]'), 'Should contain tool result');
    assert.ok(prompt.includes('{"name": "example"}'), 'Should contain tool result content');
    assert.ok(prompt.includes('What is the name field?'), 'Should contain follow-up question');
  });
});

// ─── parseToolCalls ───

describe('parseToolCalls', () => {
  it('returns content unchanged when no tool calls present', () => {
    const result = parseToolCalls('Hello, world!');
    assert.equal(result.content, 'Hello, world!');
    assert.equal(result.toolCalls, null);
  });

  it('extracts a single tool call and strips it from content', () => {
    const result = parseToolCalls(
      'I\'ll read that file for you.\n<tool_call>{"name": "read_file", "arguments": {"path": "package.json"}}</tool_call>',
    );
    assert.equal(result.content, "I'll read that file for you.");
    assert.ok(result.toolCalls !== null);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].function.name, 'read_file');
    assert.equal(JSON.parse(result.toolCalls[0].function.arguments).path, 'package.json');
  });

  it('extracts multiple tool calls', () => {
    const result = parseToolCalls(
      '<tool_call>{"name": "read_file", "arguments": {"path": "a.js"}}</tool_call>\n' +
        '<tool_call>{"name": "read_file", "arguments": {"path": "b.js"}}</tool_call>\n' +
        'Let me look at both files.',
    );
    assert.equal(result.toolCalls.length, 2);
    assert.equal(result.content, 'Let me look at both files.');
  });

  it('returns null content when only tool calls are present', () => {
    const result = parseToolCalls('<tool_call>{"name": "bash", "arguments": {"command": "ls -la"}}</tool_call>');
    assert.ok(result.content === null || result.content === '');
    assert.equal(result.toolCalls.length, 1);
  });

  it('gracefully handles invalid JSON in tool call blocks', () => {
    const result = parseToolCalls('Hello\n<tool_call>not json</tool_call>\nWorld');
    assert.equal(result.toolCalls, null, 'Invalid JSON should result in no tool calls');
    assert.ok(result.content.includes('Hello'), 'Should preserve surrounding text');
  });

  it('extracts native XML tool format (Claude/Minimax)', () => {
    const xml = `
<minimax:tool_call>
<invoke>
<tool_name>seq-prod_SeqSearch</tool_name>
<parameter name="filter">@Timestamp > Now() - 1d</parameter>
<parameter name="count">15</parameter>
</invoke>
</minimax:tool_call>
Here is my search.
    `;
    const result = parseToolCalls(xml);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].function.name, 'seq-prod_SeqSearch');
    const args = JSON.parse(result.toolCalls[0].function.arguments);
    assert.equal(args.filter, '@Timestamp > Now() - 1d');
    assert.equal(args.count, '15');
    assert.equal(result.content, 'Here is my search.');
  });

  it('extracts native Claude 3 tool use XML format', () => {
    const xml = `
<function_calls>
<tool_use>
<name>get_weather</name>
<input>
<location>San Francisco, CA</location>
<unit>fahrenheit</unit>
</input>
</tool_use>
</function_calls>
The weather should be nice.
    `;
    const result = parseToolCalls(xml);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].function.name, 'get_weather');
    const args = JSON.parse(result.toolCalls[0].function.arguments);
    assert.equal(args.location, 'San Francisco, CA');
    assert.equal(args.unit, 'fahrenheit');
    assert.equal(result.content, 'The weather should be nice.');
  });
});

// ─── pruneMessageHistory ───

describe('pruneMessageHistory', () => {
  it('preserves system prompts and suffix window turns dynamically', () => {
    const messages = [
      { role: 'system', content: 'System instruction' },
      { role: 'user', content: 'Turn 1' },
      { role: 'assistant', content: 'Turn 2' },
      { role: 'user', content: 'Turn 3' },
      { role: 'assistant', content: 'Turn 4' },
      { role: 'user', content: 'Turn 5' },
    ];
    // Keep last 4 turns + preserve first user message
    const pruned = pruneMessageHistory(messages, 4);
    assert.equal(pruned.length, 6, 'Should keep 6 messages (1 system + 1 first user + 4 suffix)');
    assert.equal(pruned[0].content, 'System instruction');
    assert.equal(pruned[1].content, 'Turn 1');
    assert.equal(pruned[2].content, 'Turn 2');
    assert.equal(pruned[5].content, 'Turn 5');
  });

  it('keeps both tool call and tool response in sync (bilateral pairing)', () => {
    const messages = [
      { role: 'system', content: 'System instruction' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'tc_1', content: 'Command successful' },
      { role: 'user', content: 'New user prompt' },
      { role: 'assistant', content: 'Assistant response' },
    ];
    // Keep last 3 turns (indices 2, 3, 4), which includes the tool response.
    // Bilateral sync will pull in the assistant tool call (index 1) which is outside the suffix window.
    const pruned = pruneMessageHistory(messages, 3);
    assert.equal(pruned.length, 5, 'Should keep all 5 messages due to bilateral tool sync');
  });

  it('performs clone-on-prune immutability to prevent payload mutation side-effects', () => {
    const messages = [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'Small query' },
      { role: 'assistant', content: 'Response' },
    ];
    const pruned = pruneMessageHistory(messages, 2);
    assert.notEqual(pruned[0], messages[0], 'Message objects should be cloned');
    assert.notEqual(pruned[1], messages[1], 'Message objects should be cloned');
  });

  it('safe-truncates massive JSON tool observations outside suffix window', () => {
    const largeObj = [];
    for (let i = 0; i < 100; i++) {
      largeObj.push({ id: i, payload: 'a'.repeat(100) });
    }
    const massiveJson = JSON.stringify(largeObj);
    const messages = [
      { role: 'system', content: 'System instruction' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'db_query', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'tc_1', content: massiveJson },
      { role: 'user', content: 'Active user turn 1' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'db_query', arguments: '{}' } }],
      },
      { role: 'user', content: 'Active turn 3' },
      { role: 'assistant', content: 'Active turn 4' },
    ];
    // Suffix window is last 4 turns (starts at index 3).
    // Assistant message at index 4 references 'tc_1' tool call and keeps tool response (2) via bilateral sync.
    const pruned = pruneMessageHistory(messages, 4);
    const toolMsg = pruned.find((m) => m.role === 'tool');
    assert.ok(toolMsg, 'Tool message should be preserved');
    assert.ok(toolMsg.content.includes('Data truncated for speed'), 'Should contain JSON preview warning');
    const parsed = JSON.parse(toolMsg.content);
    assert.equal(parsed.warning, 'Data truncated for speed');
    assert.ok(Array.isArray(parsed.preview), 'Preview field should contain a truncated array slice');
  });

  it('safely handles structured array content-parts', () => {
    const messages = [
      { role: 'system', content: [{ type: 'text', text: 'System content parts' }] },
      { role: 'user', content: [{ type: 'text', text: 'Query content parts' }] },
    ];
    const pruned = pruneMessageHistory(messages, 40000);
    assert.equal(pruned.length, 2);
    assert.deepEqual(pruned[0].content, [{ type: 'text', text: 'System content parts' }]);
  });

  it('soft-truncates excessively massive first user messages (preservation message guard)', () => {
    const massiveText = 'a'.repeat(20000);
    const messages = [
      { role: 'system', content: 'System instruction' },
      { role: 'user', content: massiveText },
      { role: 'assistant', content: 'Turn 2' },
      { role: 'user', content: 'Turn 3' },
      { role: 'assistant', content: 'Turn 4' },
      { role: 'user', content: 'Turn 5' },
    ];
    const pruned = pruneMessageHistory(messages, 4);
    const firstUserMsg = pruned.find((m) => m.role === 'user');
    assert.ok(firstUserMsg, 'First user message should be preserved');
    assert.ok(firstUserMsg.content.includes('EXCESSIVELY MASSIVE GOAL CONTEXT'), 'Should contain truncation marker');
    assert.ok(firstUserMsg.content.length < 12000, 'Should be truncated below 12000 characters');
  });
});
