'use strict';

const https = require('https');
const { log } = require('../utils');

// ─────────────────────────────────────────────
// HTTPS Request Interceptor
// Captures validation tokens from Antigravity's outgoing
// HTTPS requests to its sidecar server.
// ─────────────────────────────────────────────

const TARGET_HEADER = ['x', 'csrf', 'token'].join('-').toLowerCase();

/** Patch https.request — intercept outgoing validation tokens */
function createInterceptedRequest(ctx) {
  return function interceptedRequest(optionsOrUrl, ...args) {
    try {
      const opts = typeof optionsOrUrl === 'string' ? new URL(optionsOrUrl) : optionsOrUrl;
      const host = opts.hostname || opts.host || '';
      const port = parseInt(opts.port) || 443;
      let csrfHeader;
      if (opts.headers) {
        if (typeof opts.headers.get === 'function') {
          csrfHeader = opts.headers.get(TARGET_HEADER);
        } else {
          for (const [key, value] of Object.entries(opts.headers)) {
            if (key.toLowerCase() === TARGET_HEADER) {
              csrfHeader = value;
              break;
            }
          }
        }
      }

      if (csrfHeader && (host === 'localhost' || host === '127.0.0.1') && port > 1024) {
        if (csrfHeader !== ctx.interceptedToken || port !== ctx.interceptedPort) {
          ctx.interceptedToken = csrfHeader;
          ctx.interceptedPort = port;
          if (ctx.outputChannel) {
            ctx.outputChannel.appendLine(
              `[${new Date().toISOString().slice(11, 23)}] 🔑 [HTTPS] Intercepted verification key for port ${port}: ${csrfHeader.substring(0, 8)}...`,
            );
          }
        }
      }
    } catch {
      /* never break the original call */
    }

    return ctx._originalHttpsRequest.call(this, optionsOrUrl, ...args);
  };
}

function install(ctx) {
  ctx._originalHttpsRequest = https.request;
  ctx._interceptedRequest = createInterceptedRequest(ctx);
  https.request = ctx._interceptedRequest;
  log(ctx, `🔌 HTTPS request interceptor installed`);
}

function uninstall(ctx) {
  // Only restore if the current value is still OUR patch.
  // If another extension patched on top, we must not overwrite theirs.
  if (ctx._originalHttpsRequest && https.request === ctx._interceptedRequest) {
    https.request = ctx._originalHttpsRequest;
  }
  ctx._originalHttpsRequest = null;
  ctx._interceptedRequest = null;
  log(ctx, `🔌 HTTPS request interceptor removed`);
}

module.exports = { install, uninstall };
