// Generate WOFF codicon font from SVG sources for the VS Code extension.
// Glyphs (filename → codepoint):
//   opencode.svg   → U+E001 — OpenCode bracket logomark
//   acpilot-a.svg  → U+E002 — Agent Client Protocol (ACP) official logomark (status bar)
// Uses fantasticon with Windows glob workaround

const path = require('path');
const fs = require('fs');

// --- Monkey-patch glob to handle Windows backslashes ---
// fantasticon uses: path.join(dir, '**/*.svg') which produces
// backslashes on Windows (e.g., D:\dir\**\*.svg), but glob
// needs forward slashes (D:/dir/**/*.svg).
const globModule = require('glob');
const origGlob = globModule.glob || globModule;
if (typeof origGlob === 'function') {
  globModule.glob = function (pattern, options, cb) {
    if (typeof pattern === 'string') {
      pattern = pattern.replace(/\\/g, '/');
    }
    return origGlob.call(this, pattern, options, cb);
  };
}

const { generateFonts, FontAssetType } = require('fantasticon');

const root = path.resolve(__dirname, '..');
const dir = path.resolve(root, 'resources', 'font-icons');

console.log('Input dir:', dir);

generateFonts({
  inputDir: dir,
  outputDir: dir,
  name: 'opencode-icon',
  fontTypes: [FontAssetType.WOFF],
  normalize: true,
  codepoints: { opencode: 0xE001, 'acpilot-a': 0xE002 },
})
  .then(() => {
    // Remove fantasticon's extra generated files (css, html, json, ts)
    for (const f of ['opencode-icon.css', 'opencode-icon.html', 'opencode-icon.json', 'opencode-icon.ts']) {
      const fp = path.join(dir, f);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    console.log('✅ Font generated successfully!');
    console.log(`   WOFF: ${path.join(dir, 'opencode-icon.woff')}`);
    console.log(`   Codepoints: opencode=U+E001, acpilot-a=U+E002`);
  })
  .catch((e) => {
    console.error('❌ Error:', e.message);
    process.exit(1);
  });
