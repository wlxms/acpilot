import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, access, symlink } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

interface PreparedProfile {
  profileDir: string;
  sourceProfileDir: string;
  adapterPatchPath: string;
  cleanup(): Promise<void>;
  cleanupSync(): void;
}

interface DesktopRuntime {
  prepareDesktopProfile(options: { dshHome: string; storageDir: string }): Promise<PreparedProfile>;
  parseDesktopDshArgs(args: string[], cwd?: string): { patchFiles: string[]; args: string[] };
  buildDesktopAdapterPatches(rows?: Array<{ id: string; inject?: string[]; config?: Record<string, unknown> }>, acpConfig?: Record<string, unknown>): Array<Record<string, unknown>>;
}

const fixtureRoots: string[] = [];
const moduleUrl = pathToFileURL(path.resolve(process.cwd(), 'dsh-bridge/desktop-profile.mjs')).href;

async function runtime(): Promise<DesktopRuntime> {
  return await import(/* @vite-ignore */ moduleUrl) as DesktopRuntime;
}

async function fixture(profileName = 'web') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'acpilot-desktop-runtime-'));
  fixtureRoots.push(root);
  const dshHome = path.join(root, 'desktop-harness');
  const storageDir = path.join(root, 'extension-storage');
  const sourceProfileDir = path.join(dshHome, 'profiles', profileName);
  await mkdir(path.join(sourceProfileDir, 'node_modules', 'custom-tools'), { recursive: true });
  const manifest = {
    name: 'desktop-web', private: true, dependencies: { 'custom-tools': '1.2.3' },
    dsh: {
      profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'custom-tools'], patchReload: 'live' },
      desktop: { generationProjection: { plugins: { 'custom-tools': { version: '1.2.3' } } } },
    },
    pnpm: { overrides: { 'custom-tools': '1.2.3' } },
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const patchText = '- id: llm-pi-ai\n  config:\n    providers:\n      local-route:\n        apiKeyEnv: LOCAL_ROUTE_KEY\n- id: agent-default-model\n  config:\n    provider: local-route\n    model: saved-model\n    reasoningEffort: max\n';
  await writeFile(path.join(sourceProfileDir, 'package.json'), manifestText);
  await writeFile(path.join(sourceProfileDir, 'cordis.patch.yml'), patchText);
  await writeFile(path.join(sourceProfileDir, 'node_modules', 'custom-tools', 'fixture.txt'), 'installed custom tool');
  await writeFile(path.join(dshHome, '.credentials.yaml'), 'credential fixture remains in Desktop home');
  return { root, dshHome, storageDir, sourceProfileDir, manifestText, patchText };
}

afterEach(async () => {
  for (const root of fixtureRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('shared DSH Desktop runtime profile', () => {
  it('preserves Desktop settings and custom dependencies in an extension-owned ACP profile', async () => {
    const input = await fixture();
    const prepared = await (await runtime()).prepareDesktopProfile(input);
    const manifest = JSON.parse(await readFile(path.join(prepared.profileDir, 'package.json'), 'utf8'));
    expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app', 'custom-tools']);
    expect(manifest.dependencies).toEqual({ 'custom-tools': '1.2.3' });
    expect(manifest.dsh.desktop.generationProjection.plugins).toEqual({ 'custom-tools': { version: '1.2.3' } });
    expect(await readFile(path.join(prepared.profileDir, 'cordis.patch.yml'), 'utf8')).toBe(input.patchText);
    expect(await readFile(path.join(prepared.profileDir, 'node_modules', 'custom-tools', 'fixture.txt'), 'utf8')).toBe('installed custom tool');
    expect(await realpath(path.join(prepared.profileDir, 'node_modules'))).toBe(await realpath(path.join(input.sourceProfileDir, 'node_modules')));
    expect(await readFile(path.join(input.sourceProfileDir, 'package.json'), 'utf8')).toBe(input.manifestText);
    expect(await readFile(path.join(input.sourceProfileDir, 'cordis.patch.yml'), 'utf8')).toBe(input.patchText);
    expect(await readFile(path.join(input.dshHome, '.credentials.yaml'), 'utf8')).toBe('credential fixture remains in Desktop home');
    expect(path.relative(await realpath(input.storageDir), prepared.profileDir).startsWith('..')).toBe(false);
    expect(JSON.parse(await readFile(prepared.adapterPatchPath, 'utf8'))).toContainEqual({ id: 'acp', config: {} });
    await prepared.cleanup();
  });

  it('unlinks only its scratch profile during cleanup and preserves the junction target', async () => {
    const input = await fixture();
    await mkdir(input.storageDir, { recursive: true });
    await writeFile(path.join(input.storageDir, 'keep.txt'), 'unrelated extension state');
    const prepared = await (await runtime()).prepareDesktopProfile(input);
    await prepared.cleanup();
    await prepared.cleanup();
    await expect(access(prepared.profileDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(input.sourceProfileDir, 'node_modules', 'custom-tools', 'fixture.txt'), 'utf8')).toBe('installed custom tool');
    expect(await readFile(path.join(input.storageDir, 'keep.txt'), 'utf8')).toBe('unrelated extension state');
  });

  it('uses the legacy desktop profile when no web profile is installed', async () => {
    const input = await fixture('desktop');
    const prepared = await (await runtime()).prepareDesktopProfile(input);
    expect(await realpath(prepared.sourceProfileDir)).toBe(await realpath(input.sourceProfileDir));
    await prepared.cleanup();
  });

  it('rejects scratch locations inside Desktop home before changing profile files', async () => {
    const input = await fixture();
    const api = await runtime();
    await expect(api.prepareDesktopProfile({ ...input, storageDir: path.join(input.dshHome, 'scratch') })).rejects.toThrow(/outside|Desktop home/i);
    await expect(api.prepareDesktopProfile({ ...input, storageDir: 'relative-storage' })).rejects.toThrow(/absolute/i);
    expect(await readFile(path.join(input.sourceProfileDir, 'package.json'), 'utf8')).toBe(input.manifestText);
  });

  it('keeps user and bridge patch ordering while forwarding ACP application arguments', async () => {
    const api = await runtime();
    const cwd = path.join(os.tmpdir(), 'desktop-launch-args');
    expect(api.parseDesktopDshArgs(['--profile', 'acp', '--patch', './user.yml', '--patch', './bridge.yml', '--help'], cwd)).toEqual({
      patchFiles: [path.resolve(cwd, './user.yml'), path.resolve(cwd, './bridge.yml')],
      args: ['--help'],
    });
    expect(api.parseDesktopDshArgs(['acp', '--patch=./extra.yml'], cwd)).toEqual({ patchFiles: [path.resolve(cwd, './extra.yml')], args: [] });
    expect(() => api.parseDesktopDshArgs(['--profile', 'web'])).toThrow(/ACP|acp/);
    expect(() => api.parseDesktopDshArgs(['--patch'])).toThrow(/patch/i);
  });

  it('disables required web hosts while retaining compatible tools and default model inheritance', async () => {
    const patches = (await runtime()).buildDesktopAdapterPatches([
      { id: 'custom-web-host', inject: ['webServer', 'tools'] },
      { id: 'custom-workspace-host', inject: ['workspaceRegistry'] },
      { id: 'compatible-tools', inject: ['typertGateway', 'tools', 'skills'] },
    ]);
    expect(patches).toContainEqual({ id: 'custom-web-host', disabled: true });
    expect(patches).toContainEqual({ id: 'custom-workspace-host', disabled: true });
    expect(patches).toContainEqual({ id: 'ui-git-graph', disabled: true });
    expect(patches).toContainEqual({ id: 'ui-task-board', disabled: true });
    expect(patches).toContainEqual({ id: 'skills-manager', disabled: true });
    expect(patches).not.toContainEqual({ id: 'compatible-tools', disabled: true });
    expect(patches).toContainEqual({ id: 'acp', config: {} });
  });

  it('removes its scratch profile on process exit without deleting installed tools', async () => {
    const input = await fixture();
    const script = `
      const { prepareDesktopProfile } = await import(${JSON.stringify(moduleUrl)});
      const prepared = await prepareDesktopProfile(${JSON.stringify({ dshHome: input.dshHome, storageDir: input.storageDir })});
      process.once('exit', () => prepared.cleanupSync());
      process.stdout.write(JSON.stringify({ profileDir: prepared.profileDir }));
      process.exit(0);
    `;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    const result = JSON.parse(output) as { profileDir: string };
    await expect(access(result.profileDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(input.sourceProfileDir, 'node_modules', 'custom-tools', 'fixture.txt'), 'utf8')).toBe('installed custom tool');
  });

  it('initializes ACP model controls from the composed Desktop default without hardcoding a route', async () => {
    const input = await fixture();
    const rowsPath = path.join(input.root, 'composed-profile.json');
    await writeFile(rowsPath, JSON.stringify([
      { id: 'agent-default-model', config: { provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'max' } },
      { id: 'acp', config: { provider: 'shipped-provider', model: 'shipped-model' } },
    ]));
    const rows = JSON.parse(await readFile(rowsPath, 'utf8'));
    const patches = (await runtime()).buildDesktopAdapterPatches(rows);
    expect(patches).toContainEqual({ id: 'acp', config: { provider: 'fixture-provider', model: 'fixture-model' } });
  });

  it('retains explicit ACP settings while supplying the Desktop model fallback', async () => {
    const patches = (await runtime()).buildDesktopAdapterPatches([
      { id: 'agent-default-model', config: { provider: 'desktop-provider', model: 'desktop-model' } },
    ], { provider: 'custom-provider', model: 'custom-model', sessionListPageSize: 23 });
    expect(patches).toContainEqual({ id: 'acp', config: { provider: 'custom-provider', model: 'custom-model', sessionListPageSize: 23 } });
  });

  it('preserves market bundle switches byte for byte in the private profile', async () => {
    const input = await fixture();
    const stateText = '{\n  "disabled": ["custom-tools"],\n  "installed": {"custom-tools": "1.2.3"}\n}\n';
    await mkdir(path.join(input.sourceProfileDir, '.dsh-market'), { recursive: true });
    const sourceState = path.join(input.sourceProfileDir, '.dsh-market', 'state.json');
    await writeFile(sourceState, stateText);
    const prepared = await (await runtime()).prepareDesktopProfile(input);
    expect(await readFile(path.join(prepared.profileDir, '.dsh-market', 'state.json'), 'utf8')).toBe(stateText);
    await prepared.cleanup();
    expect(await readFile(sourceState, 'utf8')).toBe(stateText);
  });

  it('keeps relative plugin modules and assets resolvable from the private profile', async () => {
    const input = await fixture();
    const patchText = `${input.patchText}- insert:\n    - id: local-plugin\n      name: ./local-plugin.mjs\n`;
    const pluginText = "import { readFileSync } from 'node:fs';\nexport const value = readFileSync(new URL('./assets/tool.txt', import.meta.url), 'utf8');\n";
    await mkdir(path.join(input.sourceProfileDir, 'assets'), { recursive: true });
    await writeFile(path.join(input.sourceProfileDir, 'assets', 'tool.txt'), 'local plugin asset');
    await writeFile(path.join(input.sourceProfileDir, 'local-plugin.mjs'), pluginText);
    await writeFile(path.join(input.sourceProfileDir, 'cordis.patch.yml'), patchText);
    await writeFile(path.join(input.sourceProfileDir, 'cordis.yml'), 'generated source config');
    const prepared = await (await runtime()).prepareDesktopProfile(input);
    const plugin = await import(/* @vite-ignore */ pathToFileURL(path.join(prepared.profileDir, 'local-plugin.mjs')).href);
    expect(plugin.value).toBe('local plugin asset');
    expect(await readFile(path.join(prepared.profileDir, 'cordis.patch.yml'), 'utf8')).toBe(patchText);
    await expect(access(path.join(prepared.profileDir, 'cordis.yml'))).rejects.toMatchObject({ code: 'ENOENT' });
    await prepared.cleanup();
    expect(await readFile(path.join(input.sourceProfileDir, 'local-plugin.mjs'), 'utf8')).toBe(pluginText);
    expect(await readFile(path.join(input.sourceProfileDir, 'assets', 'tool.txt'), 'utf8')).toBe('local plugin asset');
    expect(await readFile(path.join(input.sourceProfileDir, 'cordis.patch.yml'), 'utf8')).toBe(patchText);
  });

  it('cleans copied resource junctions without removing their external targets', async () => {
    const input = await fixture();
    const externalAssets = path.join(input.root, 'external-assets');
    await mkdir(externalAssets, { recursive: true });
    await writeFile(path.join(externalAssets, 'keep.txt'), 'shared external asset');
    await mkdir(path.join(input.sourceProfileDir, 'assets'), { recursive: true });
    await symlink(externalAssets, path.join(input.sourceProfileDir, 'assets', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const prepared = await (await runtime()).prepareDesktopProfile(input);
    expect(await readFile(path.join(prepared.profileDir, 'assets', 'linked', 'keep.txt'), 'utf8')).toBe('shared external asset');
    await prepared.cleanup();
    expect(await readFile(path.join(externalAssets, 'keep.txt'), 'utf8')).toBe('shared external asset');
    expect(await readFile(path.join(input.sourceProfileDir, 'assets', 'linked', 'keep.txt'), 'utf8')).toBe('shared external asset');
  });

  it('reports malformed profile settings without echoing credential snippets', async () => {
    const input = await fixture();
    const modulesDir = path.join(input.root, 'install', 'node_modules', '@deepseek-ai');
    const cliDirectory = path.join(modulesDir, 'dsh', 'lib');
    const appBootDirectory = path.join(modulesDir, 'dsh-app-boot');
    await mkdir(cliDirectory, { recursive: true });
    await mkdir(appBootDirectory, { recursive: true });
    await writeFile(path.join(modulesDir, 'dsh', 'package.json'), '{"type":"module"}');
    await writeFile(path.join(cliDirectory, 'bin.js'), '');
    await writeFile(path.join(cliDirectory, 'profile-boot.js'), 'export async function runProfile() {}');
    await writeFile(path.join(appBootDirectory, 'package.json'), '{"type":"module","main":"index.js"}');
    await writeFile(path.join(appBootDirectory, 'index.js'), 'export function loadProfileDirectory() { const error = new Error("invalid YAML at line 7: apiKey: FAKE_SECRET_MARKER"); error.name = "YAMLException"; throw error; }');
    const result = spawnSync(process.execPath, [
      path.resolve(process.cwd(), 'dsh-bridge', 'desktop-launch.mjs'),
      path.join(cliDirectory, 'bin.js'), input.storageDir, '--', '--profile', 'acp',
    ], { env: { ...process.env, DSH_HOME: input.dshHome }, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/Desktop ACP|profile|configuration/i);
    expect(result.stderr).not.toContain('FAKE_SECRET_MARKER');
    expect(result.stderr).not.toContain('apiKey:');
    expect(await readFile(path.join(input.sourceProfileDir, 'cordis.patch.yml'), 'utf8')).toBe(input.patchText);
  });

  it('emits only the saved selection fields with a launch nonce and respects explicit ACP overrides', async () => {
    const api = await runtime() as DesktopRuntime & {
      desktopSavedSelectionMarker?: (rows: Array<Record<string, unknown>>, acp: Record<string, unknown>, nonce?: string) => string | undefined;
    };
    const rows = [{ id: 'agent-default-model', config: { provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'max', apiKey: 'FAKE_SECRET_MARKER' } }];
    expect(api.desktopSavedSelectionMarker?.(rows, {}, 'test-nonce')).toBe(
      'ACPILOT_DSH_DESKTOP_SAVED_SELECTION\t' + JSON.stringify({ protocol: 1, nonce: 'test-nonce', provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: 'max' }),
    );
    expect(api.desktopSavedSelectionMarker?.(rows, { provider: 'explicit-provider' }, 'test-nonce')).toBeUndefined();
    expect(api.desktopSavedSelectionMarker?.(rows, { reasoningEffort: '' }, 'test-nonce')).toBeUndefined();
    expect(api.desktopSavedSelectionMarker?.(rows, {}, undefined)).toBeUndefined();
  });
});
