/**
 * ACPilot's optional DeepSeek Harness presentation bridge.
 *
 * ACP owns stdout. This plugin only observes the DSH tool lifecycle and emits
 * versioned, JSON-safe presentation messages on stderr, where ACPilot's DSH
 * backend can merge them with standard ACP tool updates.
 */

export const name = 'acpilot-dsh-bridge'
export const inject = ['tools']
export const ACPILOT_DSH_BRIDGE_SERVICE = 'acpilotDshBridge'
export const ACPILOT_DSH_BRIDGE_PROTOCOL = 1
export const ACPILOT_DSH_BRIDGE_PLUGIN = '@wlxms/acpilot-dsh-bridge'
export const ACPILOT_DSH_BRIDGE_TOOL_PREFIX = 'ACPILOT_DSH_BRIDGE_TOOL\t'

export function apply(ctx) {
  const nonce = process.env.ACPILOT_DSH_BRIDGE_NONCE
  const tools = ctx.tools

  const emit = (message) => {
    try {
      process.stderr.write(`${ACPILOT_DSH_BRIDGE_TOOL_PREFIX}${JSON.stringify(message)}\n`)
    } catch {
      // A bridge failure must never affect a DSH tool call or ACP stdout.
    }
  }

  const sessionIdentity = (exec) => {
    const id = exec?.agent?.session?.id ?? exec?.agent?.id
    return typeof id === 'string' && id.trim() ? id : undefined
  }

  const toolDefinition = (exec) => {
    try {
      // DSH resolves an execution against the Agent scope. Passing that scope
      // to ToolRuntime.get is essential when a user overrides a global tool in
      // an individual agent or registers the tool only for that agent.
      return exec?.agent
        ? tools.get(exec.name, exec.agent)
        : tools.get(exec.name)
    } catch {
      return undefined
    }
  }

  const callPresentation = (exec) => {
    const definition = toolDefinition(exec)
    try {
      const presented = definition?.presentCall?.(exec.arguments)
      if (isPresentation(presented)) return presented
    } catch {
      // Fall through to a provider-neutral generic card.
    }
    return {
      card: 'generic',
      title: exec.name,
      kind: toolKind(exec.name),
      rawInput: exec.arguments,
    }
  }

  const resultPresentation = (exec, result) => {
    const definition = toolDefinition(exec)
    try {
      const presented = definition?.presentResult?.(exec.arguments, {
        content: result.content,
        isError: result.isError,
        ...(result.meta !== undefined ? { meta: result.meta } : {}),
      })
      return isPresentation(presented) ? presented : undefined
    } catch {
      return undefined
    }
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    const sessionId = sessionIdentity(exec)
    const presentation = callPresentation(exec)
    if (sessionId) {
      emit({
        type: 'tool_call',
        protocol: ACPILOT_DSH_BRIDGE_PROTOCOL,
        sessionId,
        toolCallId: exec.callId,
        rootToolCallId: exec.rootCallId ?? exec.callId,
        toolName: exec.name,
        rawInput: exec.arguments,
        presentation,
      })
    }
    const decision = await next()
    if (presentation.card === 'diff' && decision?.kind === 'allow') {
      return {
        kind: 'ask',
        reason: presentationTitle(presentation) ?? `Allow ${exec.name}`,
      }
    }
    return decision
  })

  ctx.on('tools/result', (exec, result) => {
    const sessionId = sessionIdentity(exec)
    if (!sessionId) return undefined
    const presentation = resultPresentation(exec, result)
    emit({
      type: 'tool_result',
      protocol: ACPILOT_DSH_BRIDGE_PROTOCOL,
      sessionId,
      toolCallId: exec.callId,
      rootToolCallId: exec.rootCallId ?? exec.callId,
      toolName: exec.name,
      isError: result.isError === true,
      output: result.content,
      ...(presentation ? { presentation } : {}),
    })
    return undefined
  })

  const ready = {
    plugin: ACPILOT_DSH_BRIDGE_PLUGIN,
    protocol: ACPILOT_DSH_BRIDGE_PROTOCOL,
    ...(nonce ? { nonce } : {}),
  }
  // The marker is optional and only identifies an explicitly configured bridge.
  // ACP stdout remains exclusively owned by the official DSH ACP server.
  if (nonce) {
    process.stderr.write(`ACPILOT_DSH_BRIDGE_READY\t${JSON.stringify(ready)}\n`)
  }

  if (typeof ctx.provide === 'function') {
    ctx.provide(ACPILOT_DSH_BRIDGE_SERVICE, Object.freeze({
      plugin: ACPILOT_DSH_BRIDGE_PLUGIN,
      protocol: ACPILOT_DSH_BRIDGE_PROTOCOL,
      ...(nonce ? { nonce } : {}),
      emits: 'stderr',
    }))
  }
}

function isPresentation(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.card === 'string'
    && value.card.length > 0
}

function toolKind(name) {
  const value = String(name).toLowerCase()
  if (value.includes('read')) return 'read'
  if (value.includes('edit') || value.includes('write') || value.includes('delete') || value.includes('move')) return 'edit'
  if (value.includes('grep') || value.includes('glob') || value.includes('search') || value.includes('list')) return 'search'
  if (value.includes('fetch') || value.includes('url')) return 'fetch'
  if (value.includes('bash') || value.includes('shell') || value.includes('pwsh') || value.includes('exec') || value.includes('command')) return 'execute'
  return 'other'
}

function presentationTitle(presentation) {
  return typeof presentation?.title === 'string' && presentation.title.trim()
    ? presentation.title
    : undefined
}
