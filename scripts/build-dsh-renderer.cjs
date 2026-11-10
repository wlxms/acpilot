/* Build the trusted GenUI runtime once; model data never supplies frontend code. */
const esbuild = require('esbuild');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'resources', 'dsh-renderer');
// Keep logical dependency paths so worktree junctions produce the same bundle
// inputs and license inventory as a normal node_modules installation.
const genui = path.join(root, 'node_modules', '@changfenhuang', 'dsh-genui');
const packageVersion = '0.15.0';
const assets = ['mermaid.js', 'three.js', 'echarts-core.js', 'echarts-full.js', 'icons.js', 'maplibre.js'];

async function findPackage(filename) {
  let directory = path.dirname(filename);
  while (directory.startsWith(root + path.sep)) {
    try {
      const data = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
      return { directory, data };
    } catch { directory = path.dirname(directory); }
  }
  return undefined;
}

async function filesUnder(directory) {
  const names = await fs.readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of names) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(filename));
    else if (entry.isFile()) result.push(filename);
  }
  return result;
}

async function main() {
  const packageData = JSON.parse(await fs.readFile(path.join(genui, 'package.json'), 'utf8'));
  if (packageData.version !== packageVersion) throw new Error('GenUI runtime version differs from the pinned build version');
  if (path.relative(root, output) !== path.join('resources', 'dsh-renderer')) throw new Error('Unsafe renderer output directory');
  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(path.join(output, 'assets'), { recursive: true });
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: ['webviews/dsh-renderer/renderer.tsx'],
    bundle: true, outfile: path.join(output, 'renderer.js'),
    platform: 'browser', format: 'iife', target: ['chrome110'],
    jsx: 'automatic', minify: true, sourcemap: false, metafile: true, preserveSymlinks: true,
    legalComments: 'eof',
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.module.css': 'local-css', '.css': 'css', '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
    assetNames: 'fonts/[name]-[hash]',
    plugins: [{
      name: 'genui-standalone-host',
      setup(build) {
        build.onResolve({ filter: /primitive-adapter\.ts$/ }, args => {
          if (path.resolve(args.resolveDir, args.path) === path.join(genui, 'src', 'client', 'primitive-adapter.ts')) {
            return { path: path.join(genui, 'src', 'client', 'standalone', 'primitive-adapter.tsx') };
          }
        });
        build.onResolve({ filter: /^genui-standalone-theme$/ }, () => ({ path: 'theme', namespace: 'genui-theme' }));
        build.onLoad({ filter: /.*/, namespace: 'genui-theme' }, async () => {
          const source = await fs.readFile(path.join(genui, 'src', 'client', 'artifact', 'standalone-theme.ts'), 'utf8');
          const match = /export const STANDALONE_THEME_CSS = \x60([\s\S]*?)\x60/.exec(source);
          if (match === null) throw new Error('Cannot locate pinned GenUI standalone theme');
          return { contents: match[1], loader: 'css' };
        });
      },
    }],
  });
  for (const asset of assets) await fs.copyFile(path.join(genui, 'lib', 'assets', asset), path.join(output, 'assets', asset));
  for (const notice of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await fs.copyFile(path.join(genui, notice), path.join(output, notice));

  // Keep the full licenses of bundled source dependencies and unchanged engine notices.
  const dependencies = new Map();
  for (const input of Object.keys(result.metafile.inputs)) {
    if (!input.startsWith('node_modules/')) continue;
    const info = await findPackage(path.resolve(root, input));
    if (info !== undefined) dependencies.set(info.directory, info.data);
  }
  const licenseSections = [await fs.readFile(path.join(root, 'webviews/dsh-renderer/licenses/ENGINES.txt'), 'utf8')];
  for (const [directory, data] of [...dependencies].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
    const licenseFiles = (await fs.readdir(directory)).filter(name => /^(?:LICEN[CS]E|COPYING|NOTICE)(?:[.\-_].*)?$/i.test(name)).sort();
    for (const filename of licenseFiles) {
      const stat = await fs.stat(path.join(directory, filename));
      if (stat.isFile()) licenseSections.push('===== ' + data.name + ' ' + data.version + ' / ' + filename + ' =====\n\n' + await fs.readFile(path.join(directory, filename), 'utf8'));
    }
  }
  const seenNotices = new Set();
  for (const filename of ['renderer.js', ...assets.map(name => 'assets/' + name)]) {
    const source = await fs.readFile(path.join(output, filename), 'utf8');
    const comments = (source.match(/\/\*[\s\S]*?\*\//g) ?? []).filter(comment => /copyright|@license|SPDX-License|licensed under|permission to use/i.test(comment));
    const unique = comments.filter(comment => !seenNotices.has(comment) && seenNotices.add(comment));
    if (unique.length > 0) licenseSections.push('===== Embedded notices from ' + filename + ' =====\n\n' + unique.join('\n\n'));
  }
  await fs.writeFile(path.join(output, 'BUNDLED_LICENSES.txt'), licenseSections.join('\n\n'), 'utf8');
  const files = [];
  for (const filename of (await filesUnder(output)).sort()) {
    const bytes = await fs.readFile(filename);
    files.push({ path: path.relative(output, filename).split(path.sep).join('/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify({
    protocol: 1, renderer: { id: 'dsh.genui', version: 1 },
    runtime: { package: packageData.name, version: packageData.version },
    entry: { script: 'renderer.js', style: 'renderer.css', assets: 'assets/' },
    sourceDependencies: [...dependencies.values()].map(data => ({ package: data.name, version: data.version })).sort((a, b) => a.package.localeCompare(b.package)),
    files,
  }, null, 2) + '\n', 'utf8');
  console.log('Built GenUI ' + packageData.version + ' renderer with ' + assets.length + ' local engines (' + files.length + ' files).');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
