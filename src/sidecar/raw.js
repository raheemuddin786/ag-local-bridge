'use strict';

const { log, verboseLog } = require('../utils');
const { extractText } = require('../images');
const { discoverSidecar } = require('./discovery');
const { makeH2JsonCall } = require('./rpc');
const { callSidecarChat } = require('./cascade');

// Map raw-inference string enum → sidecar numeric model value
const MODEL_ENUM_TO_VALUE = {
  MODEL_PLACEHOLDER_M84: 1018,
  MODEL_PLACEHOLDER_M16: 1037,
  MODEL_PLACEHOLDER_M36: 1036,
  MODEL_PLACEHOLDER_M35: 1035,
  MODEL_PLACEHOLDER_M26: 1026,
  MODEL_OPENAI_GPT_OSS_120B_MEDIUM: 342,
};

// ─────────────────────────────────────────────
// Raw Inference via GetModelResponse
// Bypasses Cascade entirely — pure LLM inference.
//
// Schema (decoded from sidecar protobuf):
//   Request:  { prompt: string, model: string }
//   Response: { response: string }
// ─────────────────────────────────────────────

/**
 * Format OpenAI-style messages into a single prompt string for GetModelResponse.
 *
 * The raw endpoint only accepts a flat prompt, so we concatenate all messages
 * with role labels. Tool definitions and results are formatted inline.
 */
function formatMessagesAsPrompt(messages, tools) {
  const parts = [];

  // If tools are provided, add them as a system-level block
  if (tools && tools.length > 0) {
    parts.push('# Available Tools\n');
    parts.push('When you need to use a tool, respond with EXACTLY this format (one per line):');
    parts.push('<tool_call>{"name": "tool_name", "arguments": {"arg1": "value1"}}</tool_call>\n');
    parts.push('You may include multiple tool calls. After all tool calls, you may include additional text.');
    parts.push('The human will execute the tools and return the results enclosed in <observation> tags.');
    parts.push(
      'CRITICAL: Do NOT simulate tool execution. Do NOT generate <observation> tags yourself. Stop and wait for the human to return the results.\n',
    );
    for (const tool of tools) {
      if (tool.type === 'function' && tool.function) {
        const fn = tool.function;
        parts.push(`## ${fn.name}`);
        if (fn.description) parts.push(fn.description);
        if (fn.parameters) {
          parts.push('Parameters: ' + JSON.stringify(fn.parameters, null, 2));
        }
        parts.push('');
      }
    }
    parts.push('---\n');
  }

  // Format each message with role label
  for (const msg of messages) {
    const role = msg.role || 'user';
    const content = extractText(msg.content);

    if (role === 'system') {
      parts.push(`[System]\n${content}\n`);
    } else if (role === 'user') {
      parts.push(`[User]\n${content}\n`);
    } else if (role === 'assistant') {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // Format assistant tool calls so the model sees the conversation flow
        const toolCallTexts = msg.tool_calls.map((tc) => {
          const fn = tc.function || {};
          return `<tool_call>{"name": "${fn.name}", "arguments": ${fn.arguments || '{}'}}</tool_call>`;
        });
        parts.push(`[Assistant]\n${content || ''}${toolCallTexts.join('\n')}\n`);
      } else {
        parts.push(`[Assistant]\n${content}\n`);
      }
    } else if (role === 'tool') {
      // Tool results are shown with their tool_call_id for context, enclosed in observation tags
      // to satisfy models that are heavily fine-tuned on XML schema flows (Claude, Minimax)
      const toolName = msg.name || msg.tool_call_id || 'tool';
      parts.push(`<observation>\n[Tool Result: ${toolName}]\n${content}\n</observation>\n`);
    }
  }

  return parts.join('\n');
}

/**
 * Parse tool calls from the LLM's raw text response.
 * Looks for <tool_call>...</tool_call> blocks and extracts them.
 *
 * Hallucination fence: only the portion of the response *before* the first
 * <observation> tag is parsed.  When a raw-inference model runs a self-contained
 * ReAct loop in one shot it generates:
 *   <tool_call>A</tool_call>
 *   <observation>fake result</observation>   ← hallucinated
 *   <tool_call>B based on fake A</tool_call> ← unreliable!
 * Discarding everything from the first <observation> onward enforces proper
 * single-step turn-based tool calling: the client executes real tool(s),
 * sends real results back, and the model generates the next step using
 * actual data — the same as OpenAI / Anthropic tool calling.
 *
 * @returns {{ content: string, toolCalls: Array|null }}
 */
function parseToolCalls(responseText) {
  const toolCalls = [];

  // ── Hallucination fence ─────────────────────────────────────────────────
  // Only consider text before the first <observation> tag.
  const firstObsIdx = responseText.search(/<observation>/i);
  const parseText = firstObsIdx !== -1 ? responseText.substring(0, firstObsIdx) : responseText;

  // Parse 1: Custom JSON `<tool_call>` format
  const toolCallRegex = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
  let match;
  while ((match = toolCallRegex.exec(parseText)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      toolCalls.push({
        index: toolCalls.length,
        id: `call_${Date.now()}_${toolCalls.length}`,
        type: 'function',
        function: {
          name: parsed.name,
          arguments: typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments || {}),
        },
      });
    } catch {
      // If JSON parsing fails, skip this tool call
    }
  }

  // Parse 2: Native XML format used by Claude/Minimax (`<invoke>` blocks)
  // Supports `<minimax:tool_call><invoke>...</invoke></minimax:tool_call>` or direct `<invoke>`
  const invokeRegex = /<invoke>\s*<tool_name>([\s\S]*?)<\/tool_name>([\s\S]*?)<\/invoke>/g;
  while ((match = invokeRegex.exec(parseText)) !== null) {
    const fnName = match[1].trim();
    const paramBlock = match[2];
    const args = {};
    const paramRegex = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g;
    let pMatch;
    while ((pMatch = paramRegex.exec(paramBlock)) !== null) {
      args[pMatch[1]] = pMatch[2].trim();
    }
    toolCalls.push({
      index: toolCalls.length,
      id: `call_${Date.now()}_${toolCalls.length}`,
      type: 'function',
      function: {
        name: fnName,
        arguments: JSON.stringify(args),
      },
    });
  }

  // Parse 3: Native Claude 3 format (`<tool_use>` blocks)
  // `<tool_use>\n<name>tool_name</name>\n<input>\n<param_name>value</param_name>\n</input>\n</tool_use>`
  const toolUseRegex = /<tool_use>\s*<name>([\s\S]*?)<\/name>\s*<input>([\s\S]*?)<\/input>\s*<\/tool_use>/g;
  while ((match = toolUseRegex.exec(parseText)) !== null) {
    const fnName = match[1].trim();
    const paramBlock = match[2];
    const args = {};
    // Extract everything that looks like `<param_key>param_value</param_key>`
    const paramRegex = /<([a-zA-Z0-9_-]+)>([\s\S]*?)<\/\1>/g;
    let pMatch;
    while ((pMatch = paramRegex.exec(paramBlock)) !== null) {
      args[pMatch[1]] = pMatch[2].trim();
    }
    toolCalls.push({
      index: toolCalls.length,
      id: `call_${Date.now()}_${toolCalls.length}`,
      type: 'function',
      function: {
        name: fnName,
        arguments: JSON.stringify(args),
      },
    });
  }

  // Remove tool blocks from the pre-fence text to get the pure conversational text.
  // Anything after firstObsIdx is hallucinated ReAct continuation — already excluded.
  let content = parseText.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '');
  content = content.replace(/<minimax:tool_call>[\s\S]*?<\/minimax:tool_call>/g, '');
  content = content.replace(/<function_calls>[\s\S]*?<\/function_calls>/g, ''); // Common wrapper
  content = content.replace(/<invoke>[\s\S]*?<\/invoke>/g, '');
  content = content.replace(/<tool_use>[\s\S]*?<\/tool_use>/g, '');
  content = content.trim();

  return {
    content: content || null,
    toolCalls: toolCalls.length > 0 ? toolCalls : null,
  };
}

/**
 * Gap-free, Production-Grade Proxy-Side Context Optimizer.
 * Preserves strict message chronology, keeps matching tool call/response pairs,
 * preserves all system instructions, and maintains immediate conversational history.
 *
 * @param {Array} messages - Original OpenAI-compatible messages array
 * @param {number} maxTurnsToKeep - Number of recent conversational turns to preserve fully (default: 8)
 * @returns {Array} Optimized, chronologically correct messages array
 */
function pruneMessageHistory(messages, maxTurnsToKeep = 8) {
  if (!messages || messages.length <= maxTurnsToKeep + 2) return messages;

  const totalMessages = messages.length;
  const keepIndices = new Set();

  // 1. Identify Suffix (Always keep the latest conversation turns)
  const suffixStartIndex = Math.max(0, totalMessages - maxTurnsToKeep);
  for (let i = suffixStartIndex; i < totalMessages; i++) {
    keepIndices.add(i);
  }

  // 2. Identify and Preserve System Prompts
  for (let i = 0; i < totalMessages; i++) {
    if (messages[i].role === 'system') {
      keepIndices.add(i);
    }
  }

  // 3. Map out Tool Calls and Tool Responses to ensure strict pairing
  const toolCallMap = new Map(); // Maps tool_call_id -> assistant message index
  const toolResponseMap = new Map(); // Maps tool_call_id -> tool message index

  for (let i = 0; i < totalMessages; i++) {
    const msg = messages[i];
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.id) toolCallMap.set(tc.id, i);
      }
    } else if (msg.role === 'tool' && msg.tool_call_id) {
      toolResponseMap.set(msg.tool_call_id, i);
    }
  }

  // 4. Force Keep both sides of any tool chain if at least one side is in our keep set
  // This prevents 'missing tool call id' or 'missing tool response' API validation crashes
  let addedNewIndex = true;
  while (addedNewIndex) {
    addedNewIndex = false;
    for (const [callId, callIdx] of toolCallMap.entries()) {
      const responseIdx = toolResponseMap.get(callId);

      if (responseIdx !== undefined) {
        const hasCall = keepIndices.has(callIdx);
        const hasResponse = keepIndices.has(responseIdx);

        // Bilateral sync: if we have one, we must include the other!
        if (hasCall && !hasResponse) {
          keepIndices.add(responseIdx);
          addedNewIndex = true;
        } else if (hasResponse && !hasCall) {
          keepIndices.add(callIdx);
          addedNewIndex = true;
        }
      }
    }
  }

  // 5. Build the final array maintaining original chronological order
  const finalMessages = messages.filter((_, idx) => keepIndices.has(idx));

  // 6. 2026 Compression Standard: Safely compress massive tool outputs in the final set
  for (let i = 0; i < finalMessages.length; i++) {
    const msg = finalMessages[i];
    // Only compress older tool messages (outside the suffix window) that contain massive data blocks
    const originalIndex = messages.indexOf(msg);
    if (originalIndex < suffixStartIndex && msg.role === 'tool' && typeof msg.content === 'string') {
      // If the tool content is > 8KB (e.g. read_file output), compress the middle
      if (msg.content.length > 8000) {
        // Try to identify if it is raw JSON to avoid breaking JSON parsers
        const isJson = msg.content.trim().startsWith('{') || msg.content.trim().startsWith('[');
        if (!isJson) {
          msg.content =
            msg.content.substring(0, 4000) +
            `\n\n... [TRUNCATED ${msg.content.length - 6000} CHARS OF OLD CONTEXT FOR SPEED] ...\n\n` +
            msg.content.substring(msg.content.length - 2000);
        }
      }
    }
  }

  return finalMessages;
}

// A production-grade SJF Priority Queue with Aging
class PriorityInferenceQueue {
  constructor() {
    this.queue = [];
    this.running = false;
    this.cooldownMs = 2000;
  }

  /**
   * Enqueue a job with a dynamic priority cost based on prompt size.
   * @param {Function} taskFn - The async function that executes the request.
   * @param {number} promptLength - The size of the prompt (cost/burst estimate).
   * @returns {Promise<any>}
   */
  enqueue(taskFn, promptLength) {
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const job = {
      taskFn,
      promptLength,
      addedAt: Date.now(),
      resolve,
      reject,
    };

    this.queue.push(job);
    this._processNext();

    return promise;
  }

  async _processNext() {
    if (this.running || this.queue.length === 0) return;
    this.running = true;

    try {
      while (this.queue.length > 0) {
        const now = Date.now();

        // ─── SHORTEST-JOB-FIRST + AGING ALGORITHM ───
        // We sort based on prompt size, but we subtract 200 virtual characters
        // for every second a request has been waiting to prevent starvation.
        this.queue.sort((a, b) => {
          const ageA = (now - a.addedAt) / 1000; // in seconds
          const ageB = (now - b.addedAt) / 1000;

          const scoreA = a.promptLength - ageA * 200;
          const scoreB = b.promptLength - ageB * 200;

          return scoreA - scoreB;
        });

        const job = this.queue.shift();

        try {
          const result = await job.taskFn();
          job.resolve(result);
        } catch (err) {
          job.reject(err);
        }

        // Rest the sidecar gRPC layer for 2 seconds before executing next
        await new Promise((r) => setTimeout(r, this.cooldownMs));
      }
    } finally {
      this.running = false;
    }
  }
}

const priorityQueue = new PriorityInferenceQueue();

function enqueueInference(fn, promptLength = 0) {
  return priorityQueue.enqueue(fn, promptLength);
}

/**
 * Call the sidecar's GetModelResponse for raw LLM inference.
 *
 * @param {Object} ctx - Bridge context
 * @param {Array} messages - OpenAI-format messages
 * @param {string} modelEnum - Model enum string (e.g. 'MODEL_PLACEHOLDER_M18')
 * @param {Array|null} tools - OpenAI tool definitions
 * @param {Array} images - Array of extracted image objects
 * @returns {{ content: string|null, toolCalls: Array|null }}
 */
async function callRawInference(ctx, messages, modelEnum, tools = null, images = []) {
  // ─── CONTEXT OPTIMIZATION & PRUNING ───
  const optimizedMessages = pruneMessageHistory(messages, 8);
  if (optimizedMessages.length !== messages.length) {
    log(
      ctx,
      `🧹 Payload optimized: Pruned intermediate turns from ${messages.length} down to ${optimizedMessages.length}`,
    );
  }

  if (images && images.length > 0) {
    log(ctx, `🖼️ Images detected! Raw inference does not support vision. Routing to Cascade API...`);
    const numericModelValue = MODEL_ENUM_TO_VALUE[modelEnum] || 1035;
    // Cascade is the ONLY endpoint that natively supports the 'media' field for images.
    const text = await callSidecarChat(ctx, optimizedMessages, numericModelValue, null, null, images);
    return { content: text, toolCalls: null };
  }

  const info = await discoverSidecar(ctx);
  if (!info) throw new Error('Sidecar not discovered');

  if (!info.csrfTokens || info.csrfTokens.length === 0) {
    throw new Error('Sidecar discovered but no CSRF tokens available');
  }
  const mainCsrf = info.csrfTokens[0];

  // Find a working LS port — try non-extension ports first, then extension port as fallback.
  // The LS ports may have died while the extension port stays alive; trying all ports
  // avoids 'No reachable LS port' when the sidecar recycles its gRPC listeners.
  const lsPorts = [
    ...info.actualPorts.filter((p) => p !== info.extensionServerPort),
    info.extensionServerPort, // last resort — extension port may also serve LS gRPC
  ];
  let lsPort = null;
  for (const port of lsPorts) {
    try {
      await makeH2JsonCall(port, mainCsrf, info.certPath, 'GetStatus', {});
      lsPort = port;
      break;
    } catch {
      // try next port
    }
  }

  // ─── SELF-HEALING PORT RECOVERY ───
  if (!lsPort) {
    log(ctx, '⚠️ No reachable LS port in cached sidecar info. Attempting active recovery (fresh scan)...');

    // Invalidate the cache and force a new process tree search
    ctx.sidecarInfo = null;
    ctx.sidecarInfoTimestamp = 0;

    const freshInfo = await discoverSidecar(ctx);
    if (freshInfo) {
      const freshCsrf = freshInfo.csrfTokens[0];
      const freshPorts = [
        ...freshInfo.actualPorts.filter((p) => p !== freshInfo.extensionServerPort),
        freshInfo.extensionServerPort,
      ];

      for (const port of freshPorts) {
        try {
          await makeH2JsonCall(port, freshCsrf, freshInfo.certPath, 'GetStatus', {});
          lsPort = port;
          log(ctx, `✅ Active recovery succeeded! Connected to fresh port: ${port}`);
          break;
        } catch {
          // try next port
        }
      }
    }
  }

  if (!lsPort) {
    ctx.sidecarInfo = null;
    ctx.sidecarInfoTimestamp = 0;
    throw new Error('No reachable LS port');
  }

  // Format the prompt using optimized history
  const prompt = formatMessagesAsPrompt(optimizedMessages, tools);

  log(ctx, `🧠 Raw inference: ${prompt.length} chars, model=${modelEnum}, tools=${tools ? tools.length : 0}`);

  // Call GetModelResponse with an extended timeout.
  // Large prompts or slow thinking models can take several minutes.
  const INFERENCE_TIMEOUT_MS = 900000; // 15 minutes

  const reqBody = {
    prompt,
    model: modelEnum,
  };

  // Retry loop for transient RESOURCE_EXHAUSTED / model-not-found errors.
  // enqueueInference serializes all calls: only 1 GetModelResponse at a time,
  // with a 2-second cooldown between consecutive calls.
  const MAX_RETRIES = 2;
  const RETRY_DELAY_MS = 5000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      log(ctx, `⏳ Retry ${attempt}/${MAX_RETRIES} after ${RETRY_DELAY_MS / 1000}s backoff...`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }

    try {
      const result = await enqueueInference(
        () => makeH2JsonCall(lsPort, mainCsrf, info.certPath, 'GetModelResponse', reqBody, 1, INFERENCE_TIMEOUT_MS),
        prompt.length,
      );

      const responseText = (result && result.response) || '';
      verboseLog(ctx, `🧠 Raw response dump (${responseText.length} chars)`, responseText);
      log(ctx, `🧠 Raw response: ${responseText.length} chars`);

      // Check if upstream silently returned a Google API proxy error as plaintext.
      // Only flag short responses (< 1000 chars) — longer responses are valid completions
      // where the model may quote these strings while discussing error-handling code.
      if (
        responseText.length < 1000 &&
        (responseText.includes("Method doesn't allow unregistered callers") ||
          responseText.includes('RESOURCE_EXHAUSTED'))
      ) {
        throw new Error(`Upstream API failed: ${responseText.substring(0, 200)}`);
      }

      if (responseText.trim().length === 0) {
        return {
          content:
            '⚠️ **Inference Blocked**: The model returned an empty response. This usually occurs when the prompt triggers a Google API safety filter (e.g. sensitive code, PII, or security flags) or encounters a silent internal error. Please modify your prompt and try again.',
          toolCalls: null,
        };
      }

      // Auth failure — invalidate sidecar cache so next request triggers re-discovery.
      const isAuthError =
        responseText.length < 500 &&
        (responseText.includes('PERMISSION_DENIED') ||
          responseText.includes('Verify your account') ||
          responseText.includes('403 Forbidden') ||
          /^(?:HTTP )?401\b/i.test(responseText.trim()));

      if (isAuthError) {
        log(ctx, '⚠️ Auth failure detected in raw response — invalidating sidecar cache to force re-discovery');
        ctx.sidecarInfo = null;
        ctx.sidecarInfoTimestamp = 0;
        throw new Error(`Auth failure (sidecar cache cleared): ${responseText.substring(0, 200)}`);
      }

      // Success — parse tool calls if applicable and return
      if (tools && tools.length > 0) {
        return parseToolCalls(responseText);
      }
      return { content: responseText, toolCalls: null };
    } catch (err) {
      const errMsg = err.message || '';
      const isRetryable =
        errMsg.includes('RESOURCE_EXHAUSTED') ||
        errMsg.includes('model not found') ||
        errMsg.includes('unknown model key');

      if (attempt < MAX_RETRIES && isRetryable) {
        log(ctx, `⚠️ Raw inference attempt ${attempt + 1} failed: ${errMsg.substring(0, 100)}`);
        continue;
      }
      throw err;
    }
  }
}

module.exports = { callRawInference, formatMessagesAsPrompt, parseToolCalls };
