'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http2 = require('http2');
const h2Interceptor = require('../src/interceptors/h2');

describe('H2 Interceptor', () => {
  it('installs, intercepts, and cleanly uninstalls', () => {
    const originalConnect = http2.connect;
    const ctx = {
      capturedPayloads: [],
      MAX_CAPTURES: 20,
      outputChannel: null,
      _originalH2Connect: null,
      _interceptedH2Connect: null,
    };

    // 1. Install
    h2Interceptor.install(ctx);
    assert.notEqual(http2.connect, originalConnect);
    assert.equal(ctx._originalH2Connect, originalConnect);
    assert.equal(ctx._interceptedH2Connect, http2.connect);

    // 2. Uninstall
    h2Interceptor.uninstall(ctx);
    assert.equal(http2.connect, originalConnect);
    assert.equal(ctx._originalH2Connect, null);
    assert.equal(ctx._interceptedH2Connect, null);
  });
});
