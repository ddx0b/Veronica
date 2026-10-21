import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Optional live-provider E2E test suite.
 * Per Section 10 of SPEC.md:
 * "External-provider tests must be separated from deterministic CI tests so that CI
 * does not depend on real SMS delivery or a live personal WhatsApp session."
 *
 * Run with: LIVE_E2E=true CONFIG_PATH=./config.json npm run test:live
 */
const runLive = process.env.LIVE_E2E === 'true';

describe('Live Provider E2E Suite (Gated)', { skip: !runLive }, () => {
  it('validates live configuration when LIVE_E2E=true', async () => {
    const { loadConfig } = await import('../../src/config/loader.js');
    const config = loadConfig();
    assert.ok(config.email.smtp.host.length > 0);
    assert.ok(config.whatsapp.targetChatId.length > 0);
  });
});
