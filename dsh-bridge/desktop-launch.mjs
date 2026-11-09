/** Launch Desktop's bundled Harness over ACP with a private copy of its profile. */
import path from 'node:path'
import childProcess from 'node:child_process'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildDesktopAdapterPatches, desktopSavedSelectionMarker, parseDesktopDshArgs, prepareDesktopProfile } from './desktop-profile.mjs'

const diagnostic = message => process.stderr.write(`[acpilot-desktop] ${message}\n`)

function startupErrorSummary(error) {
  if (error?.name === 'YAMLException' || error?.name === 'SyntaxError') {
    return 'Desktop ACP startup failed because the shared profile configuration could not be parsed.'
  }
  if (error?.code === 'ENOENT' || error?.code === 'MODULE_NOT_FOUND' || error?.code === 'ERR_MODULE_NOT_FOUND') {
    return 'Desktop ACP startup failed because a required installation or profile file was not found.'
  }
  if (error?.code === 'EACCES' || error?.code === 'EPERM') {
    return 'Desktop ACP startup failed because an installation, profile, or storage file could not be accessed.'
  }
  return 'Desktop ACP startup failed while preparing or activating the shared profile.'
}

// Third-party Desktop plugins may log during import or activation. ACP owns stdout.
console.log = console.error.bind(console)
console.info = console.error.bind(console)
console.debug = console.error.bind(console)

function flattenRows(rows) {
  return rows.flatMap(row => [row, ...(row.group && Array.isArray(row.config) ? flattenRows(row.config) : [])])
}

async function installDesktopHooks(cliEntryPath) {
  const archiveRoot = path.dirname(path.dirname(path.dirname(path.dirname(path.dirname(cliEntryPath)))))
  if (path.basename(archiveRoot) !== 'app.asar') return
  const resources = path.dirname(archiveRoot)
  const fallbackFile = path.join(resources, 'host-module-fallback.mjs')
  if (existsSync(fallbackFile)) {
    const fallback = await import(pathToFileURL(fallbackFile).href)
    fallback.registerHostModuleFallback(cliEntryPath)
  }
  const officeFile = path.join(resources, 'office-engine-resolution.mjs')
  if (existsSync(officeFile)) {
    const office = await import(pathToFileURL(officeFile).href)
    office.registerOfficeEngineResolution(cliEntryPath)
    process.env.DSH_DESKTOP_OFFICE_RESOURCES = path.join(resources, 'office-runtime')
    process.env.DSH_DESKTOP_OFFICE_CLI = path.join(resources, 'office-cli.mjs')
  }
  const hideFile = path.join(resources, 'windows-child-process-hide.mjs')
  if (process.platform === 'win32' && existsSync(hideFile)) {
    const hide = await import(pathToFileURL(hideFile).href)
    hide.enforceWindowsChildProcessHide(childProcess, syncBuiltinESMExports)
  }
}

async function runDesktopLaunch() {
  const [cliEntryPath, storageDir, separator, ...argv] = process.argv.slice(2)
  if (!path.isAbsolute(cliEntryPath ?? '') || !path.isAbsolute(storageDir ?? '') || separator !== '--') {
    throw new Error('Expected an absolute DSH CLI entry, an absolute ACPilot storage directory, then -- and DSH arguments.')
  }
  if (!existsSync(cliEntryPath)) throw new Error('The bundled DSH CLI entry was not found.')
  if (!path.isAbsolute(process.env.DSH_HOME ?? '')) throw new Error('DSH_HOME must identify the installed Desktop Harness home.')
  const parsed = parseDesktopDshArgs(argv)
  await installDesktopHooks(cliEntryPath)
  const installAnchor = path.resolve(path.dirname(cliEntryPath), '..', 'package.json')
  const require = createRequire(cliEntryPath)
  const appBoot = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href)
  const { runProfile } = await import(pathToFileURL(path.join(path.dirname(cliEntryPath), 'profile-boot.js')).href)
  const prepared = await prepareDesktopProfile({ dshHome: process.env.DSH_HOME, storageDir })
  let launched
  let cleaning
  const cleanup = () => cleaning ??= prepared.cleanup().catch(() => diagnostic('Could not remove the private Desktop launch profile.'))
  process.once('exit', () => {
    try {
      prepared.cleanupSync()
    } catch {
      // Termination cleanup is best effort and touches only our private directory.
    }
  })
  try {
    const profile = appBoot.loadProfileDirectory('dsh', prepared.profileDir, installAnchor)
    const userOverlays = parsed.patchFiles.flatMap(filename => appBoot.loadOverlayPatches('dsh', filename))
    const homePatch = path.join(process.env.DSH_HOME, 'cordis.patch.yml')
    const homeOverlays = existsSync(homePatch) ? appBoot.loadOverlayPatches('dsh', homePatch) : []
    const rows = flattenRows(appBoot.composeEntries([...profile.layers.map(layer => layer.patches), profile.patches, homeOverlays, userOverlays]))
    const knownDisabled = new Set(['ui-git-graph', 'ui-task-board', 'skills-manager'])
    const modulesRequire = createRequire(path.join(prepared.profileDir, 'package.json'))
    const inspected = []
    for (const row of rows) {
      if (!row.id || !row.name || row.disabled === true || knownDisabled.has(row.id)) continue
      try {
        const plugin = await import(pathToFileURL(modulesRequire.resolve(row.name)).href)
        const exported = plugin.default ?? plugin
        inspected.push({ id: row.id, inject: exported.inject ?? plugin.inject ?? [] })
      } catch {
        // Leave resolution/application failures to Harness's labelled startup audit.
      }
    }
    const rowIds = new Set(rows.map(row => row.id))
    const injections = new Map(inspected.map(row => [row.id, row.inject]))
    const userAcpConfig = [...profile.patches, ...homeOverlays, ...userOverlays]
      .findLast(patch => !patch.insert && patch.id === 'acp' && Object.hasOwn(patch, 'config'))?.config ?? {}
    const adapterPatches = buildDesktopAdapterPatches(rows.map(row => ({ ...row, inject: injections.get(row.id) ?? row.inject })), userAcpConfig)
      .filter(patch => rowIds.has(patch.id))
    await writeFile(prepared.adapterPatchPath, `${JSON.stringify(adapterPatches, null, 2)}\n`)
    const savedMarker = desktopSavedSelectionMarker(rows, userAcpConfig, process.env.ACPILOT_DSH_BRIDGE_NONCE)
    if (savedMarker) process.stderr.write(`${savedMarker}\n`)
    // User overlays include ACPilot's bridge last; keep that ordering intact.
    launched = await runProfile({
      profile: 'acp',
      environment: appBoot.loadLayeredEnv('dsh'),
      args: parsed.args,
      patchFiles: [prepared.adapterPatchPath, ...parsed.patchFiles],
      resolvedProfile: { profile, installAnchor },
    })
    const finish = () => void launched.shutdown.shutdown(0).finally(cleanup)
    process.stdin.once('end', finish)
    process.once('SIGINT', finish)
    process.once('SIGTERM', finish)
    if (launched.ctx.fiber.state !== 2 || process.stdin.readableEnded) await cleanup()
  } catch (error) {
    await cleanup()
    throw error
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    await runDesktopLaunch()
  } catch (error) {
    // Do not serialize raw plugin configuration or credential-bearing causes.
    diagnostic(startupErrorSummary(error))
    process.exitCode = 1
  }
}
