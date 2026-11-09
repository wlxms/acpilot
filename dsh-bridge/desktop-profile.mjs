/** Files owned by ACPilot's shared Desktop launch; Desktop files stay read-only. */
import path from 'node:path'
import { lstatSync, readdirSync, realpathSync, rmSync, unlinkSync } from 'node:fs'
import { access, copyFile, cp, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'

const WEB_ONLY_IDS = ['ui-git-graph', 'ui-task-board', 'skills-manager']
const WEB_ONLY_SERVICES = new Set(['webServer', 'workspaceRegistry', 'connection', 'webStartup'])

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function canonicalCandidate(candidate) {
  const missing = []
  let current = candidate
  for (;;) {
    try {
      return path.join(await realpath(current), ...missing.reverse())
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      missing.push(path.basename(current))
      current = parent
    }
  }
}

function unlinkResourceLinks(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name)
    const info = lstatSync(filename)
    if (info.isSymbolicLink()) unlinkSync(filename)
    else if (info.isDirectory()) unlinkResourceLinks(filename)
  }
}

export function buildDesktopAdapterPatches(rows = [], acpConfig = {}) {
  const disabledIds = new Set(WEB_ONLY_IDS)
  for (const row of rows) {
    const inject = Array.isArray(row.inject) ? row.inject : Object.keys(row.inject ?? {})
    if (row.id && inject.some(service => WEB_ONLY_SERVICES.has(service))) disabledIds.add(row.id)
  }
  const savedDefault = rows.findLast(row => row.id === 'agent-default-model')?.config ?? {}
  const selection = {
    ...(typeof savedDefault.provider === 'string' ? { provider: savedDefault.provider } : {}),
    ...(typeof savedDefault.model === 'string' ? { model: savedDefault.model } : {}),
    ...acpConfig,
  }
  return [
    ...[...disabledIds].map(id => ({ id, disabled: true })),
    // ACP needs an initial selection to expose model controls before any prompt.
    { id: 'acp', config: selection },
  ]
}

/** A launch-bound preference; emit no profile config or capability defaults. */
export function desktopSavedSelectionMarker(rows = [], acpConfig = {}, nonce) {
  const field = (value, maximum) => typeof value === 'string' && value.trim().length > 0
    && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value)
  if (!field(nonce, 128) || ['provider', 'model', 'reasoningEffort'].some(key => Object.hasOwn(acpConfig, key))) return undefined
  const saved = rows.findLast(row => row.id === 'agent-default-model' && row.disabled !== true)?.config
  if (!saved || !field(saved.provider, 1024) || !field(saved.model, 1024) || !field(saved.reasoningEffort, 128)) return undefined
  return 'ACPILOT_DSH_DESKTOP_SAVED_SELECTION\t' + JSON.stringify({
    protocol: 1, nonce, provider: saved.provider, model: saved.model, reasoningEffort: saved.reasoningEffort,
  })
}

export function parseDesktopDshArgs(argv, cwd = process.cwd()) {
  const patchFiles = []
  let selected = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    let profile
    if (argument === '--profile') profile = argv[++index]
    else if (argument.startsWith('--profile=')) profile = argument.slice('--profile='.length)
    else if (argument === 'acp' && !selected) profile = argument
    if (profile !== undefined || argument === '--profile') {
      if (profile !== 'acp' || selected) throw new Error('Shared Desktop launches require one ACP profile selection (--profile acp).')
      selected = true
      continue
    }
    if (argument === '--patch' || argument.startsWith('--patch=')) {
      const filename = argument === '--patch' ? argv[++index] : argument.slice('--patch='.length)
      if (!filename || filename.startsWith('--')) throw new Error('--patch requires a file path.')
      patchFiles.push(path.resolve(cwd, filename))
      continue
    }
    return { patchFiles, args: argv.slice(index + (argument === '--' ? 1 : 0)) }
  }
  return { patchFiles, args: [] }
}

export async function prepareDesktopProfile({ dshHome, storageDir }) {
  if (!path.isAbsolute(dshHome ?? '') || !path.isAbsolute(storageDir ?? '')) {
    throw new Error('Desktop home and ACPilot storage directory must be absolute paths.')
  }
  const home = await realpath(dshHome)
  const proposedStorage = await canonicalCandidate(path.resolve(storageDir))
  if (isInside(home, proposedStorage)) throw new Error('ACPilot scratch storage must be outside the Desktop home.')

  let sourceProfileDir
  let manifestText
  for (const name of ['web', 'desktop']) {
    const candidate = path.join(home, 'profiles', name)
    try {
      manifestText = await readFile(path.join(candidate, 'package.json'), 'utf8')
      sourceProfileDir = candidate
      break
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  if (!sourceProfileDir) throw new Error('DSH Desktop has no installed web or desktop profile to share.')
  const manifest = JSON.parse(manifestText)
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || !bundles.every(bundle => typeof bundle === 'string')) {
    throw new Error('DSH Desktop profile has an invalid dsh.profile.bundles manifest.')
  }
  if (!bundles.includes('@deepseek-ai/dsh-web-app') && !bundles.includes('@deepseek-ai/dsh-acp-app')) {
    throw new Error('DSH Desktop profile does not contain a supported Web or ACP application bundle.')
  }
  manifest.dsh.profile.bundles = [...new Set(bundles.map(bundle => bundle === '@deepseek-ai/dsh-web-app' ? '@deepseek-ai/dsh-acp-app' : bundle))]

  await mkdir(proposedStorage, { recursive: true })
  const storageRoot = await realpath(proposedStorage)
  if (isInside(home, storageRoot)) throw new Error('ACPilot scratch storage must be outside the Desktop home.')
  const profileDir = await mkdtemp(path.join(storageRoot, 'desktop-acp-'))
  const adapterPatchPath = path.join(profileDir, 'acpilot-desktop.patch.json')
  const cleanupSync = () => {
    if (!isInside(storageRoot, profileDir) || profileDir === storageRoot) throw new Error('Refusing to clean an unowned Desktop launch directory.')
    try {
      const rootInfo = lstatSync(profileDir)
      if (rootInfo.isSymbolicLink()) {
        unlinkSync(profileDir)
        return
      }
      if (!isInside(storageRoot, realpathSync(profileDir))) throw new Error('Desktop launch directory moved outside ACPilot storage.')
      unlinkResourceLinks(profileDir)
      rmSync(profileDir, { recursive: true, force: true })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  const cleanup = async () => cleanupSync()
  try {
    // Bundle switches and relative plugin modules/assets are profile inputs too.
    // Keep their paths and bytes while rebuilding only our manifest and output.
    const rebuiltFiles = new Set(['node_modules', 'package.json', 'cordis.yml', 'cordis.patch.yml'])
    await cp(sourceProfileDir, profileDir, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      filter: filename => {
        const relative = path.relative(sourceProfileDir, filename)
        return relative === '' || !rebuiltFiles.has(relative.split(path.sep)[0])
      },
    })
    await writeFile(path.join(profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    try {
      await copyFile(path.join(sourceProfileDir, 'cordis.patch.yml'), path.join(profileDir, 'cordis.patch.yml'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await writeFile(path.join(profileDir, 'cordis.patch.yml'), '[]\n')
    }
    const sourceModules = path.join(sourceProfileDir, 'node_modules')
    try {
      await access(sourceModules)
      await symlink(sourceModules, path.join(profileDir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await writeFile(adapterPatchPath, `${JSON.stringify(buildDesktopAdapterPatches(), null, 2)}\n`)
    return { profileDir, sourceProfileDir, adapterPatchPath, cleanup, cleanupSync }
  } catch (error) {
    await cleanup().catch(() => {})
    throw error
  }
}
