const { randomBytes } = require('node:crypto');
const { existsSync, mkdirSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, dirname, join, resolve } = require('node:path');
const { spawn } = require('node:child_process');

const root = resolve(__dirname, '..');
const runDir = join(tmpdir(), `acpilot-runtime-${process.pid}-${Date.now()}`);
const userDataDir = join(runDir, 'user-data');
const extensionsDir = join(runDir, 'extensions');
const workspaceDir = join(runDir, 'workspace');
const descriptorPath = join(runDir, 'control.json');
const token = randomBytes(24).toString('hex');
const installedInsiders = 'C:\\Program Files\\Microsoft VS Code Insiders\\Code - Insiders.exe';
const installedStable = 'C:\\Program Files\\Microsoft VS Code\\Code.exe';
const localAppData = process.env.LOCALAPPDATA;
const localInsiders = localAppData
  ? join(localAppData, 'Programs', 'Microsoft VS Code Insiders', 'Code - Insiders.exe')
  : undefined;
const localStable = localAppData
  ? join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe')
  : undefined;
const command = process.env.VSCODE_BIN
  || process.env.VSCODE_INSIDERS_BIN
  || [installedInsiders, installedStable, localInsiders, localStable]
    .find(candidate => candidate && existsSync(candidate))
  || 'code-insiders';

// Starting the OpenCode HTTP server and making its provider catalog available
// are separate asynchronous steps. Keep the runtime check tolerant of that
// short readiness window, but fail deterministically if the catalog never
// becomes usable. The timeout can be shortened by CI without changing the
// default smoke-test behavior.
const OPENCODE_MODEL_READINESS_TIMEOUT_MS = durationFromEnv(
  'ACPILOT_RUNTIME_MODEL_READINESS_TIMEOUT_MS',
  15_000,
);
const OPENCODE_MODEL_READINESS_POLL_MS = durationFromEnv(
  'ACPILOT_RUNTIME_MODEL_READINESS_POLL_MS',
  250,
);

function durationFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function cleanupRuntimeDirectory(directory) {
  const resolvedTemp = resolve(tmpdir());
  const resolvedDirectory = resolve(directory);
  if (dirname(resolvedDirectory) !== resolvedTemp || !basename(resolvedDirectory).startsWith('acpilot-runtime-')) {
    throw new Error(`Refusing to clean unexpected runtime directory: ${resolvedDirectory}`);
  }
  rmSync(resolvedDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}

for (const directory of [runDir, userDataDir, extensionsDir, workspaceDir]) {
  mkdirSync(directory, { recursive: true });
}

const child = spawn(command, [
  '--new-window',
  ...(process.env.ACPILOT_RUNTIME_WITH_BUILTINS === '1' ? [] : ['--disable-extensions']),
  ...(process.env.ACPILOT_RUNTIME_VERBOSE === '1' ? ['--verbose'] : []),
  `--user-data-dir=${userDataDir}`,
  `--extensions-dir=${extensionsDir}`,
  `--extensionDevelopmentPath=${root}`,
  workspaceDir,
], {
  cwd: root,
  env: {
    ...process.env,
    ACPILOT_TEST_CONTROL: '1',
    ACPILOT_TEST_CONTROL_TOKEN: token,
    ACPILOT_TEST_CONTROL_FILE: descriptorPath,
  },
  shell: process.platform === 'win32' && !command.toLowerCase().endsWith('.exe'),
  stdio: 'ignore',
});

let childError;
let childExit;
child.once('error', error => {
  childError = error;
});
child.once('exit', (code, signal) => {
  childExit = { code, signal };
});

async function waitForDescriptor() {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (childError) {
      throw new Error(`Failed to start VS Code: ${childError.message}`);
    }
    if (childExit) {
      throw new Error(
        `VS Code exited before the runtime control server started (code=${childExit.code}, signal=${childExit.signal || 'none'})`,
      );
    }
    if (existsSync(descriptorPath)) {
      try {
        return JSON.parse(readFileSync(descriptorPath, 'utf8'));
      } catch {
        // The extension may still be finishing the descriptor write.
      }
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
  }
  throw new Error('Timed out waiting for the runtime control server');
}

async function execute(port, code) {
  const response = await fetch(`http://127.0.0.1:${port}/execute`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ code }),
  });
  const body = await response.json();
  if (!response.ok || !body.ok) {
    throw new Error(body.error || `Runtime request failed with ${response.status}`);
  }
  return body.result;
}

async function waitForChildExit(timeoutMs) {
  if (childExit || child.exitCode !== null) {
    return childExit || { code: child.exitCode, signal: child.signalCode };
  }
  return Promise.race([
    new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal }))),
    new Promise(resolveDelay => setTimeout(() => resolveDelay(undefined), timeoutMs)),
  ]);
}

/**
 * Wait until the eager OpenCode backend has published at least one model.
 *
 * A successful server start is not sufficient here: OpenCode can briefly
 * return an empty provider list while auth/config discovery is completing.
 * This is deliberately bounded so a missing CLI, auth setup, or provider
 * configuration still produces a useful smoke-test failure.
 */
async function waitForOpenCodeModels(port, trace) {
  const startedAt = Date.now();
  const deadline = startedAt + OPENCODE_MODEL_READINESS_TIMEOUT_MS;
  let attempts = 0;
  let models = [];

  while (true) {
    attempts += 1;
    trace('listLanguageModels opencode attempt', { attempts });
    const result = await execute(
      port,
      "return await api.listLanguageModels('opencode');",
    );
    if (!Array.isArray(result)) {
      throw new Error('opencode language-model listing did not return an array');
    }
    models = result;
    trace('listLanguageModels opencode result', { attempts, count: models.length });
    if (models.length > 0) {
      return models;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    await new Promise(resolveDelay => setTimeout(
      resolveDelay,
      Math.min(OPENCODE_MODEL_READINESS_POLL_MS, remaining),
    ));
  }

  throw new Error(
    `OpenCode language-model catalog remained empty after `
      + `${OPENCODE_MODEL_READINESS_TIMEOUT_MS}ms (${attempts} attempts)`,
  );
}


(async () => {
  try {
    const traceStartedAt = Date.now();
    const trace = (label, value) => {
      if (process.env.ACPILOT_RUNTIME_TRACE === '1') {
        console.log(`TRACE ${Date.now() - traceStartedAt}ms ${label}${value === undefined ? '' : ` ${JSON.stringify(value)}`}`);
      }
    };
    const descriptor = await waitForDescriptor();
    trace('descriptor', descriptor);
    const snapshot = await execute(descriptor.port, 'return await api.snapshot();');
    trace('snapshot', snapshot.backends.map(backend => ({ id: backend.id, status: backend.status })));
    const ids = snapshot.backends.map(backend => backend.id).sort();
    for (const required of ['acp', 'opencode', 'reasonix']) {
      if (!ids.includes(required)) {
        throw new Error(`Missing backend in runtime snapshot: ${required}`);
      }
    }
    const acp = snapshot.backends.find(backend => backend.id === 'acp');
    if (acp.instanceKey !== 'acp:unconfigured') {
      throw new Error(`Unexpected clean ACP instance identity: ${acp.instanceKey}`);
    }
    const acpState = await execute(
      descriptor.port,
      "return await api.inspectBackend('acp');",
    );
    if (acpState.id !== 'acp' || acpState.instanceKey !== 'acp:unconfigured') {
      throw new Error(`Unexpected ACP backend inspection: ${JSON.stringify(acpState)}`);
    }
    const acpSessions = await execute(
      descriptor.port,
      "return await api.listSessions('acp');",
    );
    if (!Array.isArray(acpSessions)) {
      throw new Error('ACP session listing did not return an array');
    }
    const acpModels = await execute(
      descriptor.port,
      "return await api.listModels('acp');",
    );
    if (!Array.isArray(acpModels)) {
      throw new Error('ACP model listing did not return an array');
    }
    const modelListings = {};
    for (const backendId of ['opencode', 'acp', 'reasonix']) {
      trace(`listLanguageModels ${backendId} start`);
      const models = backendId === 'opencode'
        ? await waitForOpenCodeModels(descriptor.port, trace)
        : await execute(
          descriptor.port,
          `return await api.listLanguageModels(${JSON.stringify(backendId)});`,
        );
      if (!Array.isArray(models)) {
        throw new Error(`${backendId} language-model listing did not return an array`);
      }
      trace(`listLanguageModels ${backendId} done`, { count: models.length });
      const vendors = new Set(models.map(model => model.vendor));
      if (vendors.size > 1) {
        throw new Error(`${backendId} language-model listing crossed vendor boundaries`);
      }
      for (const model of models) {
      if (model.isUserSelectable === false) {
        throw new Error(`${backendId} model ${model.id} is not user selectable`);
      }
      if (model.targetChatSessionType !== `acpilot.${backendId}`) {
        throw new Error(
          `${backendId} Agent model ${model.id} is not restricted to its Chat Session `
            + `(target=${model.targetChatSessionType ?? 'none'})`,
        );
      }
      if (!model.capabilities || !model.capabilities.toolCalling) {
        throw new Error(`${backendId} model ${model.id} is not eligible for Agent mode (toolCalling missing)`);
      }
      if (model.capabilities.agentMode !== true) {
        throw new Error(`${backendId} Agent model ${model.id} does not advertise Agent mode`);
      }
      }
      modelListings[backendId] = models;
    }
    let titleGeneration;
    if (process.env.ACPILOT_RUNTIME_TITLE_GENERATION === '1') {
      titleGeneration = await execute(
        descriptor.port,
        "return await api.generateTitle('opencode', 'Fix the OpenCode model picker integration.');",
      );
      if (!titleGeneration || !Array.isArray(titleGeneration.allModels)) {
        throw new Error(`Title generation diagnostic failed: ${JSON.stringify(titleGeneration)}`);
      }
    }
    let modelRequest;
    if (process.env.ACPILOT_RUNTIME_MODEL_REQUEST === '1') {
      const target = modelListings.opencode[0] || modelListings.acp[0] || modelListings.reasonix[0];
      if (target) {
        const backendId = target.vendor === 'opencode' ? 'opencode'
          : target.vendor === 'acp' ? 'acp' : 'reasonix';
        const started = await execute(
          descriptor.port,
          `return await api.startModelRequest(${JSON.stringify(backendId)}, ${JSON.stringify(target.id)}, 'Reply with one short sentence.');`,
        );
        modelRequest = await execute(
          descriptor.port,
          `return await api.waitModelRequest(${JSON.stringify(started.id)}, 30000);`,
        );
        if (modelRequest.status !== 'completed') {
          throw new Error(`Native model request failed: ${JSON.stringify(modelRequest)}`);
        }
      }
    }
    console.log(JSON.stringify({
      ok: true,
      backends: snapshot.backends,
      modelListings,
      titleGeneration,
      modelRequest,
    }, null, 2));
    await execute(descriptor.port, 'return await api.shutdownHost();');
    const exit = await waitForChildExit(10_000);
    if (!exit) {
      throw new Error('VS Code did not exit within 10000ms after shutdownHost()');
    }
    if (exit.code !== 0 && exit.signal === null) {
      throw new Error(`VS Code exited with code ${exit.code}`);
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 5_000));
  } finally {
    if (!childExit && child.exitCode === null) {
      try { child.kill(); } catch { /* process may have exited between checks */ }
    }
    if (process.env.ACPILOT_KEEP_RUNTIME !== '1') {
      try {
        cleanupRuntimeDirectory(runDir);
      } catch (error) {
        console.warn(`Runtime test passed, but temporary files remain at ${runDir}: ${error.message}`);
      }
    } else {
      console.log(`Runtime files retained at ${runDir}`);
    }
  }
})().catch(error => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
