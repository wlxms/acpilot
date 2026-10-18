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
  const bridgeAttached = typeof nonce === 'string' && nonce.trim().length > 0
  const approvalEnabledSessions = new WeakSet()

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

  const approvalService = (agent) => {
    const scopes = [agent?.ctx, ctx]
    for (const scope of scopes) {
      try {
        const service = scope?.get?.('approval')
        if (service) return service
      } catch {
        // Optional approval support is absent in some custom DSH profiles.
      }
      try {
        const service = scope?.approval
        if (service) return service
      } catch {
        // A topology-sensitive property can throw before the service is ready.
      }
    }
    return undefined
  }

  const ensureApprovalChannel = async (exec) => {
    if (!bridgeAttached) return
    const agent = exec?.agent
    const session = agent?.session
    if (!agent || !isRecord(session) || approvalEnabledSessions.has(session)) return

    const approval = approvalService(agent)
    if (!approval) return

    let policy
    try {
      policy = typeof approval.overrideOf === 'function'
        ? approval.overrideOf(session)
        : undefined
    } catch {
      policy = undefined
    }
    if (policy !== 'never' && approval.config?.policy !== 'never') {
      approvalEnabledSessions.add(session)
      return
    }

    try {
      const setApprovalPolicy = await loadApprovalPolicySetter()
      if (setApprovalPolicy) {
        setApprovalPolicy(session, 'ask')
      } else if (typeof approval.setPolicy === 'function') {
        // Compatibility fallback for custom DSH builds that expose the service
        // but do not publish the canonical setter module.
        approval.setPolicy(agent, 'ask')
      } else {
        return
      }
      approvalEnabledSessions.add(session)
    } catch {
      // Keep the normal ask decision fail-closed if a custom approval service
      // cannot be switched to the bridge-compatible policy.
    }
  }

  const toolDefinition = (exec) => {
    const name = typeof exec?.name === 'string' ? exec.name : undefined
    if (!name) return undefined

    // DSH can expose the execution scope in two different places. Agent-owned
    // profiles put the effective ToolRuntime on agent.ctx.tools, while older
    // runtimes expose the same lookup through the injected context service.
    // Probe both before falling back to the global registration so custom
    // Agent tools and the built-in write presenter are preserved.
    const lookups = [
      () => exec?.agent?.ctx?.tools?.get?.(name),
      () => tools?.get?.(name, exec?.agent),
      () => tools?.get?.(name),
    ]
    for (const lookup of lookups) {
      try {
        const definition = lookup()
        if (definition) return definition
      } catch {
        // A missing scope or incompatible get signature is not fatal.
      }
    }
    return undefined
  }

  const callPresentation = (exec) => {
    const definition = toolDefinition(exec)
    try {
      const presented = definition?.presentCall?.(exec.arguments)
      if (isPresentation(presented)) return presented
    } catch {
      // Fall through to a provider-neutral fallback card.
    }
    return fileMutationPresentation(exec) ?? {
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
      if (isPresentation(presented)) return presented
    } catch {
      // Fall through to a provider-neutral fallback card.
    }
    return result.isError ? undefined : fileMutationPresentation(exec)
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
    // Switch a full-access session back to the normal approval channel before
    // downstream policy listeners run. Some DSH profiles resolve approval:
    // never into a deny during next(), which would otherwise prevent ACPilot
    // from ever receiving session/request_permission.
    if (presentation.card === 'diff' && bridgeAttached) {
      await ensureApprovalChannel(exec)
    }

    const decision = await next()
    if (presentation.card === 'diff' && decision?.kind === 'allow') {
      return {
        kind: 'ask',
        reason: presentationTitle(presentation) ?? `Allow ${exec.name}`,
      }
    }
    return decision
  }, { prepend: true })

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

let approvalPolicySetterPromise

function loadApprovalPolicySetter() {
  if (!approvalPolicySetterPromise) {
    approvalPolicySetterPromise = import('@deepseek-ai/dsh-user-approval')
      .then(module => typeof module.setApprovalPolicy === 'function' ? module.setApprovalPolicy : undefined)
      .catch(() => undefined)
  }
  return approvalPolicySetterPromise
}

function fileMutationPresentation(exec) {
  const name = String(exec?.name ?? '')
  const lowered = name.toLowerCase()
  const args = exec?.arguments
  if (!isRecord(args)) return undefined
  if (!lowered.includes('write') && !lowered.includes('create') && !lowered.includes('edit')) return undefined

  const filePath = firstString(args.file_path, args.filePath, args.path, args.filename)
  const content = firstString(args.content, args.new_content, args.newContent, args.new_text, args.newText)
  if (!filePath || content === undefined) return undefined

  const verb = lowered.includes('write') || lowered.includes('create') ? 'Write' : 'Edit'
  return {
    card: 'diff',
    title: `${verb} ${filePath}`,
    kind: 'edit',
    diffs: [{ path: filePath, oldText: null, newText: content }],
    locations: [{ path: filePath }],
  }
}

function firstString(...values) {
  return values.find(value => typeof value === 'string')
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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
