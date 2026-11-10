# DSH GenUI renderer

This frontend bundles the complete public embed entry from pinned @changfenhuang/dsh-genui 0.15.0 with React 18.3.1. The package's standalone primitive adapter replaces the DSH UI primitive import at build time; it has no Cordis or DSH host peer runtime.

Build with npm run build:dsh-renderer. npm run test:renderer builds and runs real-component DOM tests using JSDOM. npm run compile also builds the renderer. Output is resources/dsh-renderer/renderer.js, renderer.css, assets/, fonts/, manifest.json and license files. Builds use local installed dependencies and pinned license source documents, with no build-time CDN requests. Lazy engine bytes are copied unchanged from the GenUI package, recorded with SHA-256 hashes in the manifest.

The host supplies a main element with id dsh-root and loads the JS/CSS through trusted Webview URIs. The JS installs its message listener before posting {type:"ready",protocol:1}. The host then sends {type:"render",protocol:1,view:{protocol:1,renderer:{id:"dsh.genui",version:1},viewId,data},assetBase,actionEnabled}. The assetBase points at the bundled assets directory; a data property cannot override it.

Model actions use the original GenuiActionContext provider. The frontend sends {type:"action",protocol:1,requestId,action,payload}; the host responds with {type:"action-result",protocol:1,requestId,ok,error?}. The extension's render instance owns session routing. The frontend does not carry or infer session identity. Disabled capability removes the provider, so GenUI action buttons are disabled. Replaced views discard pending request feedback.

GenUI's validator and node ledger run before mounting. Invalid native specs and unknown renderer versions show a diagnostic. Unregistered custom components show a diagnostic; adding another DSH plugin requires a renderer implementation. GenUI's intentional budget limits surface their warnings. The original native bars render CSS columns; line and donut charts use SVG.

GenUI's native host state API saves secret-free form answers, checkbox groups, lock state and field drafts through the Webview state API, keyed by viewId. Reopening a Webview restores those drafts. Tabs retain their local selection during the same view's unchanged rerenders; GenUI does not include tab selection in its durable snapshot, so recreated Webviews start on the first tab. Updated content reads the latest form draft before remounting. These tests cover the standalone component DOM and packaged resources, not a visible VS Code Workbench.

Styles map VS Code colors and fonts onto GenUI's own standalone defaults. The host CSP must allow local scripts/fonts, inline component styles and blob workers for MapLibre. External media/map services need the host's explicit resource policy. Rendering data never supplies script code or engine URLs.
