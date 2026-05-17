'use strict';

const { randomUUID } = require('crypto');

const pkg = require('../package.json');

/**
 * Shared mutable state for the AG Local Bridge extension.
 *
 * All state that was previously scattered as module-level `let` variables
 * in the monolithic extension.js is consolidated here. A single context
 * object is created in activate() and passed to every module.
 */
function createContext() {
  return {
    // Identity (for Metadata proto payloads)
    sessionId: randomUUID() + Date.now().toString(),
    extensionVersion: pkg.version || '1.1.86',

    // VS Code UI
    /** @type {import('vscode').OutputChannel | null} */
    outputChannel: null,
    /** @type {import('vscode').StatusBarItem | null} */
    statusBarItem: null,

    // HTTP server
    /** @type {import('http').Server | null} */
    server: null,

    // Sidecar discovery cache
    sidecarInfo: null,
    sidecarInfoTimestamp: 0,
    SIDECAR_CACHE_TTL: 300000, // 5 minutes (discovery is expensive on Windows)

    // Concurrency guard
    chatRequestsInFlight: 0,
    MAX_CONCURRENT_REQUESTS: 3,

    // Rate limiting / loop-breaking
    lastResponseTimestamp: 0,
    MIN_REQUEST_INTERVAL_MS: 200, // 200ms cooldown between responses
    lastUserMessageHash: '',
    lastUserMessageTimestamp: 0,
    DEDUP_WINDOW_MS: 1000, // 1s dedup window

    // Token intercepted from outgoing validation calls
    interceptedToken: null,
    interceptedPort: null,

    // Interceptor originals (stored for uninstall)
    _originalHttpsRequest: null,
    _originalCreateServer: null,

    // H2 interceptor captured payloads
    capturedPayloads: [],
    MAX_CAPTURES: 20,

    // Cascade conversation state
    isWorkspaceSwitching: false,
    activeCascades: new Map(), // convKey -> { id, lastUsed }
    cascadePromises: new Map(), // convKey -> Promise<string>
  };
}

module.exports = { createContext };
