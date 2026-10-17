/** Copilot model catalog assembled from backend-owned model providers. */

import type * as vscode from 'vscode';
import type { Backend, BackendModelProvider } from '../../backend/backend';
import type { BackendModel, BackendResult } from '../../backend/types';
import type { CopilotModelRegistration, ResolutionResult } from './model-types';

/** Maximum time a backend model provider may hold up one catalog refresh. */
export const MODEL_CATALOG_PROVIDER_TIMEOUT_MS = 2_000;

/**
 * Build the canonical VS Code model identity for one backend model.
 *
 * VS Code requires ids to be unique within the registered vendor provider.
 * Encode each native component so provider/model values containing '/' cannot
 * collide with a different pair.
 */
export function canonicalCopilotModelId(
  vendor: string,
  providerID: string,
  modelID: string,
  backendInstanceKey?: string,
): string {
  const components = [vendor, providerID, modelID];
  if (backendInstanceKey !== undefined) {
    components.push(backendInstanceKey);
  }
  return components.map(encodeURIComponent).join('/');
}

/** Whether a VS Code model identity belongs to the requested backend catalog. */
export function backendOwnsCopilotModel(
  entries: readonly CopilotModelRegistration[],
  backendId: string,
  vendor: string,
  modelId: string,
  backendInstanceKey: string,
): boolean {
  return entries.some(entry => entry.backendId === backendId
    && entry.vendor === vendor
    && entry.copilotModelId === modelId
    && entry.backendInstanceKey === backendInstanceKey);
}

export interface CopilotModelCatalog {
  /** Refresh every backend model catalog for the current workspace. */
  refresh(directory?: string): Promise<void>;
  list(): CopilotModelRegistration[];
  /** Resolve only a registration belonging to the requested runtime instance. */
  resolve(
    backendId: string,
    vendor: string,
    modelId: string,
    backendInstanceKey: string,
  ): ResolutionResult;
  /** Remove all registrations for one backend before a runtime switch. */
  clearBackend(backendId: string): void;
  dispose(): void;
}

export interface CreateCopilotModelCatalogOptions {
  backends: Map<string, Backend>;
  backendVendors?: Map<string, string>;
  /** Dynamic instance identity for each backend (ACP target switches in place). */
  backendInstanceKeys?: Map<string, () => string>;
  /**
   * Bound one provider call so a disconnected backend cannot strand every
   * other backend's model catalog. Defaults to two seconds.
   */
  providerTimeoutMs?: number;
  logger: vscode.OutputChannel;
}

export function createCopilotModelCatalog(opts: CreateCopilotModelCatalogOptions): CopilotModelCatalog {
  const vendors = opts.backendVendors ?? new Map<string, string>();
  const instanceKeys = opts.backendInstanceKeys ?? new Map<string, () => string>();
  const providerTimeoutMs = normalizeProviderTimeout(opts.providerTimeoutMs);
  let models: CopilotModelRegistration[] = [];
  /**
   * Keep the last successful result for each backend independently. A catalog
   * refresh is an aggregate operation, so one disconnected provider must not
   * erase a healthy backend's entries (or its own last-known entries) merely
   * because that provider failed this time.
   */
  interface BackendModelSnapshot {
    readonly backendInstanceKey: string;
    readonly entries: CopilotModelRegistration[];
  }
  const backendSnapshots = new Map<string, BackendModelSnapshot>();
  let disposed = false;
  /**
   * Backend-local invalidation epochs. Clearing one backend must not cancel an
   * in-flight refresh for every other backend in the aggregate catalog.
   */
  const backendInvalidationVersions = new Map<string, number>();
  const getBackendInstanceKey = (backendId: string): string => {
    const getter = instanceKeys.get(backendId);
    if (!getter) {return backendId;}
    try {
      const value = getter();
      return typeof value === 'string' && value.length > 0 ? value : backendId;
    } catch (error) {
      opts.logger.appendLine(
        `[model-catalog] Backend "${backendId}" instance key lookup failed: ${formatError(error)}`,
      );
      return backendId;
    }
  };
  const flattenSnapshots = (
    backendIds: readonly string[],
    snapshots: ReadonlyMap<string, BackendModelSnapshot>,
  ): CopilotModelRegistration[] => {
    const flattened: CopilotModelRegistration[] = [];
    for (const backendId of backendIds) {
      const snapshot = snapshots.get(backendId);
      if (snapshot) {
        flattened.push(...snapshot.entries);
      }
    }
    return flattened;
  };
  // A provider call can outlive its backend runtime and may never settle (for
  // example, while a remote ACP connection is being replaced). Refreshes must
  // therefore be allowed to overlap. Only the newest request may publish a
  // snapshot; superseded operations remain detached from catalog state even if
  // they eventually resolve. Their callers follow the replacement below.
  let refreshSequence = 0;
  interface RefreshRequest {
    readonly sequence: number;
    readonly superseded: Promise<void>;
    /**
     * Make callers of this request observe the replacement request. The
     * replacement itself may later be superseded, so resolving with its
     * promise deliberately adopts the whole refresh chain.
     */
    supersede(replacement?: Promise<void>): void;
  }
  let activeRefresh: RefreshRequest | undefined;

  const refresh = (directory?: string): Promise<void> => {
    if (disposed) {return Promise.resolve();}

    const previousRefresh = activeRefresh;
    let resolveSuperseded!: (value?: void | PromiseLike<void>) => void;
    const request: RefreshRequest = {
      sequence: ++refreshSequence,
      superseded: new Promise<void>(resolve => { resolveSuperseded = resolve; }),
      supersede: (replacement?: Promise<void>) => { resolveSuperseded(replacement); },
    };

    const operation = refreshNow(directory, request.sequence);
    // If a superseded caller stops observing the returned race while the
    // backend promise remains pending, still consume a later rejection from
    // the detached operation.
    void operation.catch(() => undefined);
    const completion = Promise.race([operation, request.superseded]).finally(() => {
      if (activeRefresh === request) {
        activeRefresh = undefined;
      }
    });
    activeRefresh = request;
    // A superseded provider call must not wake up and read the old/empty
    // snapshot while the replacement is still loading. The replacement can
    // run independently, so a hung older backend does not block progress.
    previousRefresh?.supersede(completion);
    return completion;
  };

  const refreshNow = async (directory: string | undefined, sequence: number): Promise<void> => {
    if (disposed) {return;}
    const isLatest = (): boolean => sequence === refreshSequence;
    const discardIfStale = (backendId?: string, backendInstanceKey?: string): boolean => {
      if (isLatest()) {return false;}
      if (backendId !== undefined) {
        opts.logger.appendLine(
          `[model-catalog] Discarding superseded model refresh for backend "${backendId}"`
            + (backendInstanceKey === undefined ? '' : ` (instance="${backendInstanceKey}")`),
        );
      } else {
        opts.logger.appendLine('[model-catalog] Discarding superseded model snapshot');
      }
      return true;
    };
    const refreshInstanceKeys = new Map<string, string>();
    const refreshBackendVersions = new Map<string, number>();
    for (const backendId of opts.backends.keys()) {
      refreshInstanceKeys.set(backendId, getBackendInstanceKey(backendId));
      refreshBackendVersions.set(backendId, backendInvalidationVersions.get(backendId) ?? 0);
    }
    const backendEntries = [...opts.backends.entries()].map(([backendId, backend]) => ({
      backendId,
      backend,
      backendInstanceKey: refreshInstanceKeys.get(backendId) ?? backendId,
    }));
    // Start from the last successful snapshot for each backend. Entries for a
    // runtime instance that changed without an explicit clear are deliberately
    // dropped; they cannot safely be routed to the replacement runtime.
    const nextSnapshots = new Map<string, BackendModelSnapshot>();
    for (const { backendId, backendInstanceKey } of backendEntries) {
      const previous = backendSnapshots.get(backendId);
      if (previous?.backendInstanceKey === backendInstanceKey) {
        nextSnapshots.set(backendId, previous);
      }
    }

    // Start each backend's one authoritative model provider before awaiting
    // any result so one disconnected backend cannot block the others.
    const refreshItems: Array<{
      backendId: string;
      backend: Backend;
      backendInstanceKey: string;
      provider: BackendModelProvider;
      vendor: string;
    }> = [];
    for (const item of backendEntries) {
      const agentProvider = item.backend.modelProvider;
      if (agentProvider) {
        refreshItems.push({
          ...item,
          provider: agentProvider,
          vendor: vendors.get(item.backendId) ?? agentProvider.vendor,
        });
      }
    }
    const refreshes: Array<Promise<BackendRefreshOutcome>> = refreshItems.map(({ backend, provider }) => {
      if (typeof backend.isRunning === 'function' && !isBackendRunning(backend)) {
        return Promise.resolve<BackendRefreshOutcome>({ kind: 'not-running' });
      }
      const timeoutMs = resolveProviderTimeout(provider, providerTimeoutMs);
      const operation = Promise.resolve().then(() => provider.listModels(directory));
      return withProviderTimeout<BackendResult<BackendModel[]>>(operation, timeoutMs);
    });
    const settled = await Promise.allSettled(refreshes);

    for (let index = 0; index < refreshItems.length; index += 1) {
      if (disposed) {return;}
      const { backendId, backendInstanceKey, provider, vendor } = refreshItems[index];
      const outcome = settled[index];
      if (!outcome || (outcome.status === 'fulfilled'
        && (outcome.value.kind === 'no-provider' || outcome.value.kind === 'not-running'))) {
        if (outcome?.status === 'fulfilled' && outcome.value.kind === 'not-running') {
          opts.logger.appendLine(
            `[model-catalog] Backend "${backendId}" is not running; keeping its last model snapshot`,
          );
        }
        continue;
      }
      if (discardIfStale(backendId, backendInstanceKey)) {return;}
      const backendVersion = refreshBackendVersions.get(backendId) ?? 0;
      if ((backendInvalidationVersions.get(backendId) ?? 0) !== backendVersion) {
        // `clearBackend` invalidated only this backend while the aggregate
        // refresh was in flight. Keep collecting unrelated backend results,
        // but never reintroduce the cleared runtime's models.
        opts.logger.appendLine(
          `[model-catalog] Discarding invalidated model refresh for backend "${backendId}" `
            + `(instance="${backendInstanceKey}")`,
        );
        continue;
      }
      if (getBackendInstanceKey(backendId) !== backendInstanceKey) {
        // A target switch happened while this provider was loading. Its
        // response belongs to the old instance and must never be published.
        // Keep collecting unrelated backend results so one runtime transition
        // does not erase healthy entries from the aggregate catalog.
        opts.logger.appendLine(
          `[model-catalog] Discarding stale model refresh for backend "${backendId}" `
            + `(instance="${backendInstanceKey}")`,
        );
        continue;
      }
      if (outcome.status === 'rejected') {
        // allSettled keeps one provider failure local to that backend.
        opts.logger.appendLine(
          `[model-catalog] Backend "${backendId}" model catalog threw: ${formatError(outcome.reason)}`,
        );
        continue;
      }
      if (outcome.value.kind === 'no-provider') {
        continue;
      }
      if (outcome.value.kind === 'not-running') {
        // The branch above handles this outcome; keep the guard explicit so a
        // future outcome extension cannot accidentally publish an empty list.
        continue;
      }
      if (outcome.value.kind === 'error') {
        opts.logger.appendLine(
          `[model-catalog] Backend "${backendId}" model catalog threw: ${formatError(outcome.value.error)}`,
        );
        continue;
      }
      if (outcome.value.kind === 'timeout') {
        const timeoutMs = resolveProviderTimeout(provider, providerTimeoutMs);
        opts.logger.appendLine(
          `[model-catalog] Backend "${backendId}" model catalog timed out after ${timeoutMs}ms`,
        );
        continue;
      }
      const result = outcome.value.result;
      if (!result || typeof result !== 'object') {
        opts.logger.appendLine(
          `[model-catalog] Backend "${backendId}" returned a malformed model catalog result`,
        );
        continue;
      }
      if (result.error !== undefined) {
        opts.logger.appendLine(`[model-catalog] Backend "${backendId}" model catalog failed: ${String(result.error)}`);
        continue;
      }
      if (result.data !== undefined && !Array.isArray(result.data)) {
        opts.logger.appendLine(
          `[model-catalog] Backend "${backendId}" returned a malformed model list`,
        );
        continue;
      }

      if (!vendor) {
        opts.logger.appendLine(
          `[model-catalog] Backend "${backendId}" has no vendor configuration; skipping`,
        );
        continue;
      }
      if (vendor !== provider.vendor) {
        // The composition root may deliberately assign a stable public
        // vendor different from the provider's internal label. The explicit
        // backend mapping remains authoritative, but record the mismatch.
        opts.logger.appendLine(
          `[model-catalog] Backend "${backendId}" vendor mapping differs `
            + `(configured=${JSON.stringify(vendor)}, provider=${JSON.stringify(provider.vendor)})`,
        );
      }

      const entries: CopilotModelRegistration[] = [];
      const seen = new Set<string>();
      for (const model of result.data ?? []) {
        if (!model || typeof model !== 'object') {continue;}
        const providerID = typeof model.provider === 'string' ? model.provider.trim() : '';
        const modelID = typeof model.id === 'string' ? model.id.trim() : '';
        if (!providerID || !modelID) {continue;}
        const normalizedModel = modelID === model.id ? model : { ...model, id: modelID };
        // A dynamic backend (currently ACP remote targets) reuses one VS
        // Code vendor and provider registration across target switches.
        // Include its concrete instance in the model id so VS Code cannot
        // rebind an old LanguageModelChat handle to a new target when the
        // catalog refreshes the same native model id.
        const copilotModelId = canonicalCopilotModelId(
          vendor,
          providerID,
          modelID,
          backendInstanceKey === backendId ? undefined : backendInstanceKey,
        );
        const key = `${backendId}/${copilotModelId}`;
        if (seen.has(key)) {continue;}
        seen.add(key);
        entries.push(toRegistration(
          backendId,
          backendInstanceKey,
          vendor,
          providerID,
          normalizedModel,
          copilotModelId,
        ));
      }
      // A well-formed successful response, including an intentional empty
      // array, replaces only this backend's snapshot. All failure paths above
      // leave its previous snapshot in `nextSnapshots` untouched.
      nextSnapshots.set(backendId, { backendInstanceKey, entries });
    }
    // A refresh may have been waiting on a backend while the extension was
    // being deactivated. Never publish a late snapshot after disposal.
    if (disposed || discardIfStale()) {return;}
    // A backend may have been cleared after its result was processed but
    // before this synchronous publication. Filter once more at the commit
    // boundary so that a result can never resurrect a cleared backend entry or
    // an instance that was replaced while the provider was loading.
    // Commit backend snapshots atomically. `clearBackend` may have run while
    // providers were loading, so invalidated or replaced instances are
    // filtered at the commit boundary and cannot be resurrected by a late
    // response. Backends removed from the registry are pruned here as well.
    const committedSnapshots = new Map<string, BackendModelSnapshot>();
    for (const { backendId, backendInstanceKey } of backendEntries) {
      const snapshot = nextSnapshots.get(backendId);
      if (!snapshot || snapshot.backendInstanceKey !== backendInstanceKey) {
        continue;
      }
      if ((backendInvalidationVersions.get(backendId) ?? 0)
        !== (refreshBackendVersions.get(backendId) ?? 0)) {
        continue;
      }
      if (getBackendInstanceKey(backendId) !== backendInstanceKey) {
        continue;
      }
      committedSnapshots.set(backendId, snapshot);
    }
    backendSnapshots.clear();
    for (const [backendId, snapshot] of committedSnapshots) {
      backendSnapshots.set(backendId, snapshot);
    }
    models = flattenSnapshots(backendEntries.map(({ backendId }) => backendId), backendSnapshots);
    opts.logger.appendLine(`[model-catalog] Refreshed ${models.length} models`);
  };

  return {
    refresh,
    list: () => models,
    resolve(backendId, vendor, modelId, backendInstanceKey): ResolutionResult {
      const expectedVendor = vendors.get(backendId);
      const match = models.find(model => model.backendId === backendId
        && model.backendInstanceKey === backendInstanceKey
        && model.vendor === vendor
        && model.copilotModelId === modelId);
      if (match && (expectedVendor === undefined || expectedVendor === vendor)) {
        return {
          kind: 'backend',
          backendId,
          backendInstanceKey: match.backendInstanceKey,
          providerID: match.providerID,
          modelID: match.modelId,
        };
      }
      return { kind: 'not-found' };
    },
    clearBackend: (backendId: string) => {
      backendInvalidationVersions.set(
        backendId,
        (backendInvalidationVersions.get(backendId) ?? 0) + 1,
      );
      backendSnapshots.delete(backendId);
      models = models.filter(model => model.backendId !== backendId);
    },
    dispose: () => {
      disposed = true;
      refreshSequence += 1;
      activeRefresh?.supersede();
      activeRefresh = undefined;
      backendSnapshots.clear();
      models = [];
    },
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ProviderRefreshOutcome<T> =
  | { kind: 'result'; result: T }
  | { kind: 'error'; error: unknown }
  | { kind: 'timeout' };

type BackendRefreshOutcome =
  | { kind: 'no-provider' }
  | { kind: 'not-running' }
  | ProviderRefreshOutcome<BackendResult<BackendModel[]>>;

function isBackendRunning(backend: Backend): boolean {
  try {
    return backend.isRunning();
  } catch {
    // A backend that cannot report its state is unavailable for this refresh;
    // retaining the previous snapshot is safer than publishing an empty one.
    return false;
  }
}

function normalizeProviderTimeout(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : MODEL_CATALOG_PROVIDER_TIMEOUT_MS;
}

function resolveProviderTimeout(
  provider: Pick<BackendModelProvider, 'listModelsTimeoutMs'>,
  fallback: number,
): number {
  return normalizeProviderTimeout(provider.listModelsTimeoutMs ?? fallback);
}

/**
 * Observe one provider independently. The timeout only bounds the catalog's
 * wait; the backend operation is left running and its eventual outcome is
 * consumed so a late rejection cannot become an unhandled promise.
 */
function withProviderTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<ProviderRefreshOutcome<T>> {
  const observed = operation.then(
    (result): ProviderRefreshOutcome<T> => ({ kind: 'result', result }),
    (error): ProviderRefreshOutcome<T> => ({ kind: 'error', error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ProviderRefreshOutcome<T>>(resolve => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
  });
  return Promise.race([observed, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

function toRegistration(
  backendId: string,
  backendInstanceKey: string,
  vendor: string,
  providerID: string,
  model: BackendModel,
  copilotModelId: string,
): CopilotModelRegistration {
  return {
    vendor,
    copilotModelId,
    modelId: model.id,
    providerID,
    displayName: model.name ?? model.id,
    family: familyForVendor(vendor, backendId),
    maxInputTokens: model.maxInputTokens ?? 128_000,
    maxOutputTokens: model.maxOutputTokens ?? 16_384,
    capabilities: {
      // Every catalog entry belongs to the backend Agent vendor.
      agentMode: true,
      imageInput: hasImageCapability(model.capabilitiesRaw) || undefined,
      toolCalling: hasToolCallingCapability(model.capabilitiesRaw) || undefined,
    },
    backendId,
    backendInstanceKey,
  };
}

function hasImageCapability(caps?: Record<string, unknown>): boolean {
  const input = caps?.input as Record<string, unknown> | undefined;
  return input?.image === true || caps?.attachment === true;
}

function hasToolCallingCapability(caps?: Record<string, unknown>): boolean {
  return [caps?.toolCalling, caps?.toolcall].some(value =>
    value === true || (typeof value === 'number' && value > 0));
}

function familyForVendor(vendor: string, backendId: string): string {
  if (vendor === 'opencode') {return 'OpenCode';}
  if (vendor === 'acp') {return 'ACP Agent';}
  if (vendor === 'reasonix') {return 'Reasonix';}
  return backendId;
}
