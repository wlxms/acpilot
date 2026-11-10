/**
 * ACPilot's optional DeepSeek Harness presentation bridge.
 *
 * ACP owns stdout. This plugin projects DSH tool and subagent lifecycles,
 * coordinates cancellation for ACPilot-managed descendants, and emits
 * versioned, JSON-safe presentation messages on stderr for the DSH backend.
 */

import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFile } from 'node:fs/promises'

export const name = 'acpilot-dsh-bridge'
export const inject = ['tools', 'llm']
export const ACPILOT_DSH_BRIDGE_SERVICE = 'acpilotDshBridge'
export const ACPILOT_DSH_BRIDGE_PROTOCOL = 1
export const ACPILOT_DSH_BRIDGE_PLUGIN = '@wlxms/acpilot-dsh-bridge'
export const ACPILOT_DSH_BRIDGE_TOOL_PREFIX = 'ACPILOT_DSH_BRIDGE_TOOL\t'
export const ACPILOT_DSH_BRIDGE_DIAGNOSTIC_PREFIX = 'ACPILOT_DSH_BRIDGE_DIAGNOSTIC\t'
export const ACPILOT_DSH_BRIDGE_CATALOG_PREFIX = 'ACPILOT_DSH_BRIDGE_CATALOG\t'

export function apply(ctx) {
  const nonce = process.env.ACPILOT_DSH_BRIDGE_NONCE
  const tools = ctx.tools
  const llm = ctx.get?.('llm') ?? ctx.llm
  const bridgeAttached = typeof nonce === 'string' && nonce.trim().length > 0
  const approvalEnabledSessions = new WeakSet()
  /** Most recent tool agent observed for each session; used for identity diagnostics. */
  const recentExecAgents = new Map()
  // The execution waterfall retains exact identity across parallel delegations.
  const execution = new AsyncLocalStorage()
  const childScopes = new Map()
  const wrappedAgents = new Map()
  const cancellationEpochs = new WeakMap()
  const searchDirectories = new WeakMap()

  const messageScope = (agent) => {
    const agentSessionId = sessionIdentity({ agent })
    const scope = childScopes.get(agentSessionId)
    return scope ? {
      sessionId: scope.sessionId,
      agentSessionId,
      subAgentInvocationId: scope.callId,
      ...(scope.subAgentInvocationId ? { parentSubAgentInvocationId: scope.subAgentInvocationId } : {}),
    } : { sessionId: agentSessionId }
  }

  const interruptScope = (id, parentAgent) => {
    const runtime = ctx.get?.('subagents') ?? ctx.subagents
    if (typeof runtime?.interrupt !== 'function') return
    const scope = childScopes.get(id)
    // interrupt authorizes the exact ancestor and throws on refusal. It keeps
    // the local inbox, so a user Stop must also discard already-queued work.
    runtime.interrupt(id, { kind: 'ancestor', agent: parentAgent })
    const child = scope?.childAgent
    const registry = ctx.get?.('agents') ?? ctx.agents
    if (scope?.cancelled && scope.active && childScopes.get(id) === scope && child
      && registry?.get?.(id) === child) {
      child.cancel({ kind: 'parent' })
    }
  }

  const observeCancellation = (agent) => {
    if (!bridgeAttached || !agent || typeof agent.cancel !== 'function' || wrappedAgents.has(agent)) return
    const original = agent.cancel
    const cancel = function(cause, ...args) {
      if (this === agent) cancellationEpochs.set(agent, (cancellationEpochs.get(agent) ?? 0) + 1)
      const result = original.call(this, cause, ...args)
      if (this !== agent || cause?.kind !== 'user') return result
      const registry = ctx.get?.('agents') ?? ctx.agents
      if (registry?.get && registry.get(agent.id) !== agent) return result
      const runtime = ctx.get?.('subagents') ?? ctx.subagents
      if (typeof runtime?.interrupt !== 'function') return result
      const rootSessionId = sessionIdentity({ agent })
      const descendantIds = new Set([rootSessionId])
      let changed = true
      while (changed) {
        changed = false
        for (const [id, scope] of childScopes) {
          if ((descendantIds.has(scope.parentSessionId) || scope.sessionId === rootSessionId) && !descendantIds.has(id)) {
            descendantIds.add(id)
            changed = true
          }
        }
      }
      descendantIds.delete(sessionIdentity({ agent }))
      // Mark the whole snapshot before interrupting any child: settlement can
      // synchronously notify another stopped ancestor during this loop.
      for (const id of descendantIds) {
        const scope = childScopes.get(id)
        if (scope?.active) scope.cancelled = true
      }
      for (const id of descendantIds) {
        if (!childScopes.get(id)?.active) continue
        try {
          // interrupt preserves this root's ability to delegate in later turns.
          interruptScope(id, agent)
        } catch (error) {
          emitBridgeDiagnostic('subagent.interrupt-error', { sessionId: agent.id, childSessionId: id, error: String(error) })
        }
      }
      return result
    }
    try {
      agent.cancel = cancel
      const deliveries = []
      wrappedAgents.set(agent, { original, cancel, deliveries })
      if (typeof agent.inject === 'function') {
        const inject = agent.inject
        for (const method of ['followup', 'steer']) {
          const original = agent[method]
          if (typeof original !== 'function') continue
          const deliver = function(message, ...args) {
            const source = message?.source
            const scope = source?.kind === 'subagent-settled' ? childScopes.get(source.senderSessionId) : undefined
            // Desktop delivers its notice before subagent/end, so this is the
            // sender's current residency epoch, including reused child ids.
            if (this === agent && scope?.cancelled && scope.parentAgent === agent) {
              const receiver = childScopes.get(sessionIdentity({ agent }))
              // An injected inbox item would prevent this stopped managed
              // ancestor from settling. Its child tool records retain results.
              if (receiver?.cancelled && receiver.childAgent === agent) return undefined
              return inject.call(this, message, ...args)
            }
            return original.call(this, message, ...args)
          }
          try {
            agent[method] = deliver
            deliveries.push({ method, original, deliver })
          } catch {
            // Immutable custom Agents retain their own delivery semantics.
          }
        }
      }
    } catch {
      // Custom providers may expose an immutable Agent; presentation still works.
    }
  }

  const restoreAgent = (agent, wrapped) => {
    if (agent.cancel === wrapped.cancel) agent.cancel = wrapped.original
    for (const { method, original, deliver } of wrapped.deliveries) {
      if (agent[method] === deliver) agent[method] = original
    }
  }

  ctx.effect?.(() => () => {
    for (const [agent, wrapped] of wrappedAgents) {
      restoreAgent(agent, wrapped)
    }
    wrappedAgents.clear()
  })

  ctx.on('agent/created', ({ agent }) => observeCancellation(agent))
  ctx.on('agent/disposed', ({ agent }) => {
    const wrapped = wrappedAgents.get(agent)
    if (wrapped) restoreAgent(agent, wrapped)
    wrappedAgents.delete(agent)
  })
  ctx.on('tools/execute', (exec, next) => {
    observeCancellation(exec.agent)
    return execution.run({ exec, cancellationEpoch: cancellationEpochs.get(exec.agent) ?? 0 }, next)
  }, { prepend: true })

  ctx.on('subagent/start', (info) => {
    const executing = execution.getStore()
    const exec = executing?.exec
    if (!exec || !sessionIdentity(exec) || typeof info.id !== 'string' || typeof info.runId !== 'string') return
    const registry = ctx.get?.('agents') ?? ctx.agents
    const scope = {
      ...messageScope(exec.agent),
      parentSessionId: sessionIdentity(exec),
      parentAgent: exec.agent,
      childAgent: info.local ? registry?.get?.(info.id) : undefined,
      callId: exec.callId,
      rootCallId: exec.rootCallId ?? exec.callId,
      toolName: exec.name,
      rawInput: exec.arguments,
      runId: info.runId,
      active: true,
      cancelled: false,
      presentation: {
        card: 'subagent',
        title: exec.arguments?.description ?? exec.name,
        agentName: exec.arguments?.agent_preset ?? info.provider,
        childSessionId: info.id,
        runId: info.runId,
        status: 'running',
      },
    }
    childScopes.set(info.id, scope)
    emit({ type: 'tool_call', protocol: ACPILOT_DSH_BRIDGE_PROTOCOL,
      sessionId: scope.sessionId,
      ...(scope.agentSessionId ? { agentSessionId: scope.agentSessionId } : {}),
      ...(scope.subAgentInvocationId ? { subAgentInvocationId: scope.subAgentInvocationId } : {}),
      ...(scope.parentSubAgentInvocationId ? { parentSubAgentInvocationId: scope.parentSubAgentInvocationId } : {}),
      toolCallId: scope.callId, rootToolCallId: scope.rootCallId, toolName: scope.toolName,
      rawInput: scope.rawInput, presentation: scope.presentation,
    })
    if (exec.signal?.aborted || executing.cancellationEpoch !== (cancellationEpochs.get(exec.agent) ?? 0)) {
      scope.cancelled = true
      try {
        interruptScope(info.id, exec.agent)
      } catch (error) {
        emitBridgeDiagnostic('subagent.interrupt-error', { sessionId: scope.parentSessionId, childSessionId: info.id, error: String(error) })
      }
    }
  })
  ctx.on('subagent/end', (info) => {
    const scope = childScopes.get(info.id)
    if (!scope || scope.runId !== info.runId) return
    scope.active = false
    const isError = info.stopReason !== 'completed' && info.stopReason !== 'end_turn'
    scope.presentation = { ...scope.presentation, status: isError ? 'error' : 'completed', stopReason: info.stopReason }
    emit({ type: 'tool_result', protocol: ACPILOT_DSH_BRIDGE_PROTOCOL,
      sessionId: scope.sessionId,
      ...(scope.agentSessionId ? { agentSessionId: scope.agentSessionId } : {}),
      ...(scope.subAgentInvocationId ? { subAgentInvocationId: scope.subAgentInvocationId } : {}),
      toolCallId: scope.callId, rootToolCallId: scope.rootCallId, toolName: scope.toolName,
      isError, output: info.lastAssistantMessage ?? '', presentation: scope.presentation,
    })
    // Retain recent ended scopes for trailing child results, without evicting
    // running descendants needed by cancellation.
    if (childScopes.size > 256) {
      for (const [id, candidate] of childScopes) {
        if (!candidate.active) childScopes.delete(id)
        if (childScopes.size <= 256) break
      }
    }
  })

  const rememberExecAgent = (sessionId, agent) => {
    if (!sessionId || !agent || typeof agent !== 'object') return
    recentExecAgents.delete(sessionId)
    recentExecAgents.set(sessionId, agent)
    if (recentExecAgents.size > 256) {
      const oldest = recentExecAgents.keys().next().value
      if (typeof oldest === 'string') recentExecAgents.delete(oldest)
    }
  }

  const emit = (message) => {
    try {
      process.stderr.write(`${ACPILOT_DSH_BRIDGE_TOOL_PREFIX}${JSON.stringify(message)}\n`)
    } catch {
      // A bridge failure must never affect a DSH tool call or ACP stdout.
    }
  }

  const emitCatalog = (models) => {
    if (models.length === 0) return
    try {
      process.stderr.write(`${ACPILOT_DSH_BRIDGE_CATALOG_PREFIX}${JSON.stringify({
        protocol: ACPILOT_DSH_BRIDGE_PROTOCOL,
        models,
      })}\n`)
    } catch {
      // Catalog diagnostics are optional and must never affect DSH.
    }
  }

  const readCatalog = async () => {
    try {
      if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') return false
      const providers = llm.listProviders()
      const models = []
      for (const provider of providers) {
        let entries
        try {
          entries = await llm.listModels(provider.id)
        } catch {
          continue
        }
        for (const entry of entries) {
          let info
          try {
            info = await llm.resolveModelInfo(provider.id, entry.id)
          } catch {
            continue
          }
          models.push({
            provider: provider.id,
            model: entry.id,
            name: info?.name ?? entry.name ?? entry.id,
            ...(Number.isInteger(info?.context?.contextWindow) && info.context.contextWindow > 0
              ? { contextWindow: info.context.contextWindow }
              : {}),
            ...(Number.isInteger(info?.defaultMaxTokens) && info.defaultMaxTokens > 0
              ? { maxOutputTokens: info.defaultMaxTokens }
              : {}),
            ...(Array.isArray(info?.reasoning?.efforts) && info.reasoning.efforts.length > 0
              ? {
                  reasoningEfforts: info.reasoning.efforts.map(effort => ({
                    value: String(effort.id),
                    name: String(effort.name),
                    ...(typeof effort.description === 'string' ? { description: effort.description } : {}),
                  })),
                  ...(typeof info.reasoning.defaultEffort === 'string'
                    ? { defaultReasoningEffort: info.reasoning.defaultEffort }
                    : {}),
                }
              : {}),
          })
        }
      }
      if (models.length === 0) return false
      emitCatalog(models)
      return true
    } catch {
      return false
    }
  }

  // LLM adapters can register after this plugin's first activation. Probe only
  // in the background, after bridge handlers are installed. The timer is
  // unref'd so it cannot keep a short-lived test or DSH CLI process alive.
  const catalogProbeTimeout = setTimeout(() => {
    void readCatalog()
  }, 1000)
  if (typeof catalogProbeTimeout.unref === 'function') catalogProbeTimeout.unref()
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
    if (!bridgeAttached) {
      emitBridgeDiagnostic('approval.channel', {
        sessionId: sessionIdentity(exec) ?? null,
        toolCallId: exec?.callId ?? null,
        toolName: exec?.name ?? null,
        status: 'bridge-disabled',
      })
      return
    }
    const agent = exec?.agent
    const session = agent?.session
    if (!agent || !isRecord(session)) {
      emitBridgeDiagnostic('approval.channel', {
        sessionId: sessionIdentity(exec) ?? null,
        toolCallId: exec?.callId ?? null,
        toolName: exec?.name ?? null,
        status: 'no-agent-session',
      })
      return
    }
    if (approvalEnabledSessions.has(session)) {
      emitBridgeDiagnostic('approval.channel', {
        sessionId: sessionIdentity(exec) ?? null,
        toolCallId: exec?.callId ?? null,
        toolName: exec?.name ?? null,
        status: 'already-enabled',
      })
      return
    }

    const approval = approvalService(agent)
    if (!approval) {
      emitBridgeDiagnostic('approval.channel', {
        sessionId: sessionIdentity(exec) ?? null,
        toolCallId: exec?.callId ?? null,
        toolName: exec?.name ?? null,
        status: 'approval-service-missing',
      })
      return
    }

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
      emitBridgeDiagnostic('approval.channel', {
        sessionId: sessionIdentity(exec) ?? null,
        toolCallId: exec?.callId ?? null,
        toolName: exec?.name ?? null,
        status: 'enabled',
        overridePolicy: policy ?? null,
        configPolicy: approval.config?.policy ?? null,
      })
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
      emitBridgeDiagnostic('approval.channel', {
        sessionId: sessionIdentity(exec) ?? null,
        toolCallId: exec?.callId ?? null,
        toolName: exec?.name ?? null,
        status: 'switched-to-ask',
        overridePolicy: policy ?? null,
        configPolicy: approval.config?.policy ?? null,
      })
    } catch (error) {
      // Keep the normal ask decision fail-closed if a custom approval service
      // cannot be switched to the bridge-compatible policy.
      emitBridgeDiagnostic('approval.channel', {
        sessionId: sessionIdentity(exec) ?? null,
        toolCallId: exec?.callId ?? null,
        toolName: exec?.name ?? null,
        status: 'switch-failed',
        overridePolicy: policy ?? null,
        configPolicy: approval.config?.policy ?? null,
        error: error instanceof Error ? error.message : String(error),
      })
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

  const callPresentation = (exec, definition) => {
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

  const resultPresentation = (exec, result, definition) => {
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
    if (!result.isError) {
      const metadataPresentation = resultMetadataPresentation(exec, result)
      if (metadataPresentation) return metadataPresentation
    }
    return result.isError ? undefined : fileMutationPresentation(exec)
  }

  const resultRichView = (exec, result, definition) => {
    if (result.isError === true) return undefined
    if (!isGenuiRenderTool(definition)) return undefined
    try {
      // DSH's output projection is authoritative, including null. Older custom
      // runtimes may omit it; only that case recomputes the same projection.
      const data = result.meta !== undefined ? result.meta
        : definition.output.presentationMeta(exec.arguments, result.value)
      if (!isRecord(data) || !Array.isArray(data.items)) return undefined
      return {
        protocol: ACPILOT_DSH_BRIDGE_PROTOCOL,
        renderer: { id: 'dsh.genui', version: 1 },
        viewId: exec.callId,
        data,
      }
    } catch {
      // A broken optional presenter must not interrupt the actual tool result.
      return undefined
    }
  }

  const resolveReadCallPresentation = async (exec, presentation) => {
    if (exec?.name !== 'read' || !isRecord(exec.arguments)
      || typeof exec.arguments.file_path !== 'string') return presentation
    const requestedPath = exec.arguments.file_path
    for (const scope of [exec.agent?.ctx, ctx]) {
      try {
        const fs = scope?.get?.('fs') ?? scope?.fs
        const workingDirectory = scope?.get?.('workingDirectory') ?? scope?.workingDirectory
        if (typeof fs?.resolve !== 'function' || typeof fs?.processPath !== 'function'
          || (exec.agent !== undefined && typeof workingDirectory?.ensure !== 'function')) continue
        // Mirror DSH's read resolution, including the live per-session directory.
        // Presentation must not rewrite arguments or substitute the launch cwd.
        const cwd = exec.agent === undefined ? undefined : await workingDirectory.ensure(exec.agent, exec.signal)
        const target = await fs.resolve(requestedPath, {
          ...(cwd !== undefined ? { cwd } : {}), signal: exec.signal,
        })
        const resolvedPath = fs.processPath(target)
        if (typeof resolvedPath !== 'string'
          || (!path.isAbsolute(resolvedPath) && !path.win32.isAbsolute(resolvedPath))) return presentation
        return {
          ...presentation,
          card: 'read',
          path: resolvedPath,
          offset: exec.arguments.offset ?? presentation.offset ?? 1,
          ...(exec.arguments.limit !== undefined ? { limit: exec.arguments.limit } : {}),
          ...(Array.isArray(presentation.locations) ? {
            locations: presentation.locations.map(location => isRecord(location) && location.path === requestedPath
              ? { ...location, path: resolvedPath } : location),
          } : {}),
        }
      } catch {
        // Optional services and custom filesystem failures retain their presenter.
        return presentation
      }
    }
    return presentation
  }

  const resolveSearchPresentation = (exec, presentation) => {
    if (presentation?.card !== 'search') return presentation
    // DSH search uses the session header cwd rather than read's filesystem
    // service. Relative result paths refer to that exact execution directory.
    const cwd = searchDirectories.get(exec) ?? exec.agent?.session?.header?.cwd ?? process.cwd()
    const resolver = path.posix.isAbsolute(cwd) ? path.posix : path.win32.isAbsolute(cwd) ? path.win32 : path
    const resolveReference = (value) => typeof value === 'string' && value.trim()
      && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value)
      ? resolver.resolve(cwd, value) : value
    const resolveItem = (item) => isRecord(item) && typeof item.path === 'string'
      ? { ...item, path: resolveReference(item.path) } : item
    return {
      ...presentation,
      cwd,
      ...(Array.isArray(presentation.paths) ? { paths: presentation.paths.map(resolveReference) } : {}),
      ...(Array.isArray(presentation.files) ? { files: presentation.files.map(resolveItem) } : {}),
      ...(Array.isArray(presentation.locations) ? { locations: presentation.locations.map(resolveItem) } : {}),
    }
  }

  /**
   * Reject an edit that is already known to fail before DSH reaches its
   * approval gate. A permission request creates ACPilot's ExternalEdit
   * baseline, and VS Code cannot retract that baseline when the edit later
   * fails, so a deterministic failure must never cross this boundary.
   */
  const preflightEditFailure = async (exec) => {
    if (exec?.name !== 'edit' || !isRecord(exec.arguments)) return undefined
    const filePath = firstString(exec.arguments.file_path, exec.arguments.filePath, exec.arguments.path, exec.arguments.filename)
    const oldString = firstString(exec.arguments.old_string, exec.arguments.oldString, exec.arguments.old_text, exec.arguments.oldText)
    if (!filePath || oldString === undefined) return undefined
    const cwd = firstString(exec?.agent?.session?.header?.cwd) ?? process.cwd()
    const targetPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath)
    let content
    try {
      content = await readFile(targetPath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return `cannot edit "${filePath}": not found`
      return undefined
    }
    const needle = String(oldString).replace(/\r\n?/g, '\n')
    const haystack = String(content).replace(/\r\n?/g, '\n')
    const matches = haystack.split(needle).length - 1
    if (matches === 0) return `old_string was not found in "${filePath}"`
    const replaceAll = exec.arguments.replace_all === true || exec.arguments.replaceAll === true
    if (!replaceAll && matches > 1) {
      return `old_string matched ${matches} times in "${filePath}"; provide a more specific old_string or set replace_all to true`
    }
    return undefined
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    const sessionId = sessionIdentity(exec)
    const definition = toolDefinition(exec)
    if (isGenuiRenderTool(definition)) {
      exec.arguments = normalizeGenuiArguments(exec.arguments)
    }
    searchDirectories.set(exec, exec.agent?.session?.header?.cwd ?? process.cwd())
    const presentation = resolveSearchPresentation(exec, await resolveReadCallPresentation(exec, callPresentation(exec, definition)))
    rememberExecAgent(sessionId, exec.agent)
    emitBridgeDiagnostic('pre-execute.begin', {
      sessionId: sessionId ?? null,
      toolCallId: exec.callId ?? null,
      toolName: exec.name ?? null,
      agentId: exec?.agent?.id ?? null,
      card: presentation.card,
      bridgeAttached,
    })
    if (sessionId) {
      emit({
        type: 'tool_call',
        protocol: ACPILOT_DSH_BRIDGE_PROTOCOL,
        ...messageScope(exec.agent),
        toolCallId: exec.callId,
        rootToolCallId: exec.rootCallId ?? exec.callId,
        toolName: exec.name,
        rawInput: exec.arguments,
        presentation,
      })
    }
    const preflightFailure = await preflightEditFailure(exec)
    emitBridgeDiagnostic('pre-execute.preflight', {
      sessionId: sessionId ?? null,
      toolCallId: exec.callId ?? null,
      toolName: exec.name ?? null,
      status: preflightFailure ? 'rejected' : 'passed',
      ...(preflightFailure ? { reason: preflightFailure } : {}),
    })
    if (preflightFailure) {
      return { kind: 'deny', reason: preflightFailure }
    }

    // DSH's pre-execute waterfall is the permission gate. Re-enable a full-
    // access approval channel before delegating so the normal downstream
    // policy listeners still run. Only an allowed downstream decision is
    // converted into `ask`; denials and other decisions remain authoritative.
    // The approval service then runs before tools/execute can dispatch, while
    // monotonic tools.guard() policies continue to run after the approval.

    if (presentation.card === 'diff' && bridgeAttached) {
      await ensureApprovalChannel(exec)
      const decision = await next()
      emitBridgeDiagnostic('pre-execute.downstream', {
        sessionId: sessionId ?? null,
        toolCallId: exec.callId ?? null,
        toolName: exec.name ?? null,
        decision: decision?.kind ?? null,
      })
      if (decision?.kind !== 'allow') return decision
      emitBridgeDiagnostic('pre-execute.ask', {
        sessionId: sessionId ?? null,
        toolCallId: exec.callId ?? null,
        toolName: exec.name ?? null,
        agentId: exec?.agent?.id ?? null,
        card: presentation.card,
        reason: presentationTitle(presentation) ?? `Allow ${exec.name}`,
      })
      return {
        kind: 'ask',
        reason: presentationTitle(presentation) ?? `Allow ${exec.name}`,
      }
    }

    return next()
  }, { prepend: true })

  // Observe the DSH approval waterfall without changing its outcome. This
  // wrapper is prepended so it also sees requests that a later ACP handler
  // forwards to ACPilot; the ACP connection remains the actual answerer.
  ctx.on('approval/request', async (request, next) => {
    const sessionId = request?.agent?.session?.id ?? request?.agent?.id ?? null
    const toolCallId = request?.callId ?? null
    const toolName = request?.toolName ?? null
    const recentAgent = typeof sessionId === 'string' ? recentExecAgents.get(sessionId) : undefined
    emitBridgeDiagnostic('approval.begin', {
      sessionId,
      toolCallId,
      toolName,
      agentId: request?.agent?.id ?? null,
      agentMatchesLastExecution: recentAgent === undefined ? null : request.agent === recentAgent,
      reason: request?.reason ?? null,
      signalAborted: request?.signal?.aborted ?? null,
    })
    let outcome
    try {
      outcome = await next()
    } catch (error) {
      emitBridgeDiagnostic('approval.error', {
        sessionId,
        toolCallId,
        toolName,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
    emitBridgeDiagnostic('approval.outcome', {
      sessionId,
      toolCallId,
      toolName,
      outcome: typeof outcome === 'string' ? outcome : typeof outcome,
    })
    return outcome
  }, { prepend: true })

  ctx.on('tools/result', (exec, result) => {
    const sessionId = sessionIdentity(exec)
    if (!sessionId) return undefined
    const childId = result.value?.kind === 'activation' ? result.value.subagentId : undefined
    const activation = typeof childId === 'string' ? childScopes.get(childId) : undefined
    // An unusually fast child can end before its admission tool returns.
    if (activation && !activation.active) return undefined
    const definition = activation ? undefined : toolDefinition(exec)
    const presentation = resolveSearchPresentation(exec, activation?.presentation ?? resultPresentation(exec, result, definition))
    const richView = resultRichView(exec, result, definition)
    emit({
      type: 'tool_result',
      protocol: ACPILOT_DSH_BRIDGE_PROTOCOL,
      ...messageScope(exec.agent),
      toolCallId: exec.callId,
      rootToolCallId: exec.rootCallId ?? exec.callId,
      toolName: exec.name,
      isError: result.isError === true,
      output: result.content,
      ...(presentation ? { presentation } : {}),
      ...(richView ? { richView } : {}),
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

/** Emit a diagnostic without changing the bridge's presentation protocol. */
function emitBridgeDiagnostic(event, fields) {
  try {
    process.stderr.write(`${ACPILOT_DSH_BRIDGE_DIAGNOSTIC_PREFIX}${JSON.stringify({
      protocol: ACPILOT_DSH_BRIDGE_PROTOCOL,
      event,
      ...fields,
    })}\n`)
  } catch {
    // Diagnostics are best-effort and must never affect DSH.
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

function resultMetadataPresentation(exec, result) {
  const meta = result?.meta
  if (!isRecord(meta)) return undefined

  const name = String(exec?.name ?? '').toLowerCase()
  const args = isRecord(exec?.arguments) ? exec.arguments : {}
  const filePath = firstString(args.file_path, args.filePath, args.path, args.filename)

  if (Array.isArray(meta.diffs)) {
    const diffs = meta.diffs
      .filter(isRecord)
      .map(diff => ({
        path: firstString(diff.path, diff.file_path, diff.filePath),
        oldText: diff.oldText ?? diff.old_text ?? null,
        newText: diff.newText ?? diff.new_text ?? null,
      }))
      .filter(diff => typeof diff.path === 'string')
    const paths = uniqueStrings([
      ...diffs.map(diff => diff.path),
      filePath,
    ])
    if (name.includes('write') || name.includes('create') || name.includes('edit') || diffs.length > 0) {
      const verb = name.includes('write') || name.includes('create') ? 'Write' : 'Edit'
      return {
        card: 'diff',
        title: `${verb} ${paths[0] ?? filePath ?? exec.name}`,
        kind: 'edit',
        diffs,
        locations: paths.map(path => ({ path })),
      }
    }
  }

  if (Array.isArray(meta.lines)
    && typeof meta.offset === 'number'
    && Number.isFinite(meta.offset)
    && typeof meta.totalLines === 'number'
    && Number.isFinite(meta.totalLines)) {
    const path = firstString(meta.path, filePath)
    if (path) {
      const lines = meta.lines
        .filter(isRecord)
        .map(line => ({ number: line.number, text: line.text }))
        .filter(line => Number.isInteger(line.number) && typeof line.text === 'string')
      return {
        card: 'read',
        path,
        offset: meta.offset,
        lines,
        totalLines: meta.totalLines,
        ...(typeof meta.lang === 'string' ? { lang: meta.lang } : {}),
        ...(Array.isArray(result.content) ? { content: result.content } : {}),
      }
    }
  }

  if (meta.shape === 'matches' && Array.isArray(meta.files)) {
    return {
      card: 'search',
      shape: 'matches',
      files: meta.files,
      truncated: meta.truncated === true,
      total: typeof meta.total === 'number' ? meta.total : meta.files.length,
    }
  }
  if (meta.shape === 'paths' && Array.isArray(meta.paths)) {
    return {
      card: 'search',
      shape: 'paths',
      paths: meta.paths.filter(value => typeof value === 'string'),
      truncated: meta.truncated === true,
      total: typeof meta.total === 'number' ? meta.total : meta.paths.length,
    }
  }

  return undefined
}

function uniqueStrings(values) {
  return [...new Set(values.filter(value => typeof value === 'string' && value.length > 0))]
}
function fileMutationPresentation(exec) {
  const name = String(exec?.name ?? '')
  const lowered = name.toLowerCase()
  const args = exec?.arguments
  if (!isRecord(args)) return undefined
  if (!lowered.includes('write') && !lowered.includes('create') && !lowered.includes('edit')) return undefined

  const filePath = firstString(args.file_path, args.filePath, args.path, args.filename)
  if (!filePath) return undefined
  const oldText = firstString(args.old_string, args.oldString, args.old_text, args.oldText)
  const newText = firstString(
    args.content,
    args.new_content,
    args.newContent,
    args.new_string,
    args.newString,
    args.new_text,
    args.newText,
  )

  const verb = lowered.includes('write') || lowered.includes('create') ? 'Write' : 'Edit'
  return {
    card: 'diff',
    title: `${verb} ${filePath}`,
    kind: 'edit',
    diffs: oldText !== undefined || newText !== undefined
      ? [{ path: filePath, oldText: oldText ?? null, newText: newText ?? null }]
      : [],
    locations: [{ path: filePath }],
  }
}

function firstString(...values) {
  return values.find(value => typeof value === 'string')
}

/** Identify the effective GenUI tool rather than relying on its public name. */
function isGenuiRenderTool(definition) {
  const description = definition?.description
  const specSchema = definition?.parameters?.properties?.spec
  return typeof description === 'string' && /\bgenui\b/i.test(description) && description.includes('dsh-ui')
    && specSchema?.type === 'object' && specSchema?.properties?.items?.type === 'array'
    && typeof definition?.output?.presentationMeta === 'function'
}

/** Repair only known component aliases, never action payloads or chart data. */
function normalizeGenuiArguments(args) {
  if (!isRecord(args) || !isRecord(args.spec) || !Array.isArray(args.spec.items)) return args
  const normalizeNode = (value, depth = 0) => {
    if (!isRecord(value) || depth > 64) return value
    const node = { ...value }
    if (node.type === 'badge' && !['label', 'text', 'value'].some(key => Object.hasOwn(node, key))
      && typeof node.content === 'string') {
      node.label = node.content
      delete node.content
    }
    if (node.type === 'row') {
      const justifyAliases = { 'space-between': 'between', 'flex-start': 'start', 'flex-end': 'end' }
      if (typeof node.justify === 'string' && Object.hasOwn(justifyAliases, node.justify)) node.justify = justifyAliases[node.justify]
      if (!Object.hasOwn(node, 'items') && Array.isArray(node.children)) {
        node.items = node.children
        delete node.children
      }
    }
    if (Array.isArray(node.items)) node.items = node.items.map(item => normalizeNode(item, depth + 1))
    if (node.type === 'tabs' && Array.isArray(node.tabs)) {
      node.tabs = node.tabs.map(tab => normalizeNode(tab, depth + 1))
    }
    if (node.type === 'table' && Array.isArray(node.details)) {
      node.details = node.details.map(items => Array.isArray(items)
        ? items.map(item => normalizeNode(item, depth + 1)) : items)
    }
    return node
  }
  return { ...args, spec: { ...args.spec, items: args.spec.items.map(item => normalizeNode(item)) } }
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
