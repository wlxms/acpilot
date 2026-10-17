/**
 * Legacy OpenCode SDK feasibility verification script.
 *
 * This script predates the BackendModelProvider and native Copilot vendor
 * route. It is retained as a direct OpenCode diagnostic; the supported
 * extension-host smoke/e2e entry point is `npm run test:runtime`.
 *
 * Connects to the running OpenCode server on port 4096 and verifies:
 *  1. config.get() returns the current provider list
 *  2. deepseek provider is already auto-detected from auth.json
 *  3. session.create() + prompt() with deepseek works
 *  4. config.update() can inject a new provider and it shows up
 *
 * Usage: node scripts/verify-bridge.mjs
 */

import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';

const SERVER_URL = 'http://127.0.0.1:4096';

async function main() {
  console.log('=== Legacy OpenCode SDK Feasibility Verification ===\n');

  // ── Phase 0: Connect ──────────────────────────────────────────
  console.log('[0] Connecting to OpenCode server...');
  const client = createOpencodeClient({ baseUrl: SERVER_URL });

  try {
    const health = await client.global.health();
    console.log(`    Server health: ${JSON.stringify(health.data)}\n`);
  } catch (e) {
    console.error(`    FAILED to connect: ${e.message}`);
    process.exit(1);
  }

  // ── Phase 1: List current providers ───────────────────────────
  console.log('[1] Current providers (from config.providers)...');
  try {
    const providersResult = await client.config.providers({});
    const providers = providersResult.data?.providers ?? [];
    for (const p of providers) {
      const modelIds = Object.keys(p.models ?? {});
      console.log(`    provider="${p.id}"  name="${p.name}"  models=[${modelIds.slice(0, 5).join(', ')}${modelIds.length > 5 ? '...' : ''}]`);
    }
    if (providers.length === 0) {
      console.log('    (no providers configured)');
    }
  } catch (e) {
    console.log(`    providers endpoint failed: ${e.message}`);
    console.log('    (this is optional - trying config.get instead)');
  }

  // ── Phase 2: Get full config ──────────────────────────────────
  console.log('\n[2] Full config (from config.get)...');
  let currentConfig;
  try {
    const configResult = await client.config.get({});
    currentConfig = configResult.data ?? {};
    const providerKeys = Object.keys(currentConfig.provider ?? {});
    console.log(`    provider entries: [${providerKeys.join(', ')}]`);
    console.log(`    model: ${currentConfig.model ?? '(auto)'}`);
    console.log(`    small_model: ${currentConfig.small_model ?? '(auto)'}`);
  } catch (e) {
    console.error(`    FAILED: ${e.message}`);
    process.exit(1);
  }

  // ── Phase 3: Verify deepseek works (already auto-detected) ───
  console.log('\n[3] Testing existing deepseek provider...');
  try {
    const createResult = await client.session.create({
      title: 'acp-verify-deepseek',
    });
    const sessionId = createResult.data?.id;
    if (!sessionId) {
      console.error('    FAILED to create session');
      process.exit(1);
    }
    console.log(`    Session created: ${sessionId}`);

    const promptResult = await client.session.prompt({
      sessionID: sessionId,
      model: { providerID: 'deepseek', modelID: 'deepseek-v4-flash' },
      parts: [{ type: 'text', text: 'Reply with exactly: OK' }],
    });
    const error = promptResult.error;
    if (error) {
      console.error(`    Prompt FAILED: ${JSON.stringify(error)}`);
    } else {
      console.log(`    Prompt SUCCESS ✓ (deepseek provider works!)`);
    }
  } catch (e) {
    console.error(`    FAILED: ${e.message}`);
    process.exit(1);
  }

  // ── Phase 4: Inject test provider via config.update ───────────
  console.log('\n[4] Injecting test provider via config.update...');
  try {
    // Read deepseek key from auth.json to use for the test provider
    const authPath = `${process.env.USERPROFILE}\\.local\\share\\opencode\\auth.json`;
    const authContent = JSON.parse(
      await (await import('fs')).promises.readFile(authPath, 'utf-8')
    );
    const deepseekKey = authContent.deepseek?.key;

    if (!deepseekKey) {
      console.log('    SKIP: no deepseek key in auth.json');
    } else {
      const updateResult = await client.config.update({
        config: {
          provider: {
            'acp-test-deepseek': {
              api: 'deepseek',
              name: 'ACP Test DeepSeek',
              options: {
                apiKey: deepseekKey,
              },
              models: {
                'deepseek-v4-flash': { name: 'DeepSeek V4 Flash (test)' },
              },
            },
          },
        },
      });
      if (updateResult.error) {
        console.error(`    Config update FAILED: ${JSON.stringify(updateResult.error)}`);
      } else {
        console.log('    Config update SUCCESS ✓');

        // Re-read config to verify injection persisted
        const recheck = await client.config.get({});
        const hasInjected = !!recheck.data?.provider?.['acp-test-deepseek'];
        console.log(`    Provider persisted in config: ${hasInjected ? 'YES ✓' : 'NO ✗'}`);
      }
    }
  } catch (e) {
    console.error(`    FAILED: ${e.message}`);
  }

  // ── Phase 5: Summary ──────────────────────────────────────────
  console.log('\n=== Verification Complete ===');
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
