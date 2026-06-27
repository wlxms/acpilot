/**
 * Unified agent/model selection state management.
 *
 * Consolidates the scattered `currentAgent` / `currentModel` fields and the
 * `loadDefaultsFromConfig` logic from extension.ts into a single class.
 *
 * VSCode-free — uses a `SelectionStorage` interface for persistence so it can
 * work with any storage backend (GlobalState, localStorage, etc.).
 */

import type { AcpBackend } from './backend';
import type { AppEventBus } from './app-event-bus';
import type { SelectionState } from './app-event-bus';
import type { AcpAgent } from './types';

// ===========================================================================
// Persistence abstraction
// ===========================================================================

export interface SelectionStorage {
  load(): SelectionState;
  save(state: SelectionState): void;
}

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Parse a config model string ("providerID/modelID" or just "modelID")
 * into a structured model selection.
 */
function parseModelString(modelStr: string): { providerID: string; modelID: string } | undefined {
  const slashIndex = modelStr.indexOf('/');
  if (slashIndex > 0 && slashIndex < modelStr.length - 1) {
    return {
      providerID: modelStr.slice(0, slashIndex),
      modelID: modelStr.slice(slashIndex + 1),
    };
  }
  // Ambiguous — caller must resolve via models list
  return undefined;
}

// ===========================================================================
// Selection store
// ===========================================================================

export class SelectionStore {
  private state: SelectionState = {};

  constructor(
    private readonly backend: AcpBackend,
    private readonly bus: AppEventBus,
    private readonly backendId: string,
    private readonly storage?: SelectionStorage,
  ) {}

  // -- read ---------------------------------------------------------------

  /** Read-only snapshot of the current selection state. */
  get(): Readonly<SelectionState> {
    return { ...this.state };
  }

  // -- mutations ---------------------------------------------------------

  /**
   * Set the current agent by ID.
   * Persists the change and emits `selection-changed`.
   */
  async setAgent(agentId: string): Promise<void> {
    this.state = { ...this.state, agent: agentId };
    this.persist();
    this.bus.emit('selection-changed', { ...this.state, backendId: this.backendId });
  }

  /**
   * Set the current model by provider and model ID.
   * Resolves the display name from the backend's model list,
   * persists the change, and emits `selection-changed`.
   */
  async setModel(providerID: string, modelID: string): Promise<void> {
    let modelDisplayName: string | undefined;

    // Resolve display name from backend models
    const modelsResult = await this.backend.config.models();
    if (modelsResult.data) {
      const model = modelsResult.data.find(
        (m) => m.id === modelID && m.provider === providerID,
      );
      if (model?.name) {
        modelDisplayName = model.name;
      }
    }

    this.state = {
      ...this.state,
      model: { providerID, modelID },
      modelDisplayName,
    };
    this.persist();
    this.bus.emit('selection-changed', { ...this.state, backendId: this.backendId });
  }

  // -- hydration / defaults ----------------------------------------------

  /**
   * Hydrate state from a persisted snapshot.
   * Only fills fields that are currently `undefined` — does NOT overwrite
   * explicit selections.
   */
  hydrate(persisted: SelectionState): void {
    const next = { ...this.state };
    if (next.agent === undefined && persisted.agent !== undefined) {
      next.agent = persisted.agent;
    }
    if (next.model === undefined && persisted.model !== undefined) {
      next.model = persisted.model;
      next.modelDisplayName = persisted.modelDisplayName;
    }
    this.state = next;
  }

  /**
   * Resolve defaults from backend configuration when no persisted override
   * is present.
   *
   * This consolidates the `loadDefaultsFromConfig` logic from extension.ts:
   *
   * 1. Fetch config and agents list in parallel
   * 2. If no model AND config.model is set, parse and resolve providerID
   * 3. If no agent AND config.default_agent is set, use it
   * 4. If still no agent, fall back to the first user-selectable (primary,
   *    non-hidden) agent
   * 5. If still no model AND the resolved agent declares a model, use it
   * 6. Persist the resolved state
   *
   * Returns the resolved (possibly unchanged) state.
   */
  async resolveDefaults(): Promise<SelectionState> {
    const [configResult, agentsResult] = await Promise.all([
      this.backend.config.get(),
      this.backend.config.agents(),
    ]);

    const config = configResult.data;
    const agents = agentsResult.data ?? [];

    let { agent, model } = this.state;

    // --- Resolve model from config ---------------------------------------
    if (!model && config?.model) {
      const parsed = parseModelString(config.model);
      if (parsed) {
        // Direct parse: "providerID/modelID"
        model = parsed;
      } else {
        // Ambiguous model string — need to find provider from models list
        const modelsResult = await this.backend.config.models();
        if (modelsResult.data) {
          const matched = modelsResult.data.find((m) => m.id === config.model);
          if (matched?.provider) {
            model = { providerID: matched.provider, modelID: config.model };
          }
        }
      }
    }

    // --- Resolve agent from config ---------------------------------------
    if (!agent && config?.default_agent) {
      agent = config.default_agent;
    }

    // --- Fall back to first user-selectable agent ------------------------
    if (!agent) {
      const selectable = agents.filter(isUserSelectableAgent);
      if (selectable.length > 0) {
        agent = selectable[0].id;
      }
    }

    // --- Resolve model from agent's declaration --------------------------
    if (!model && agent) {
      const agentDef = agents.find((a) => a.id === agent);
      if (agentDef?.model) {
        if (typeof agentDef.model === 'string') {
          const parsed = parseModelString(agentDef.model);
          if (parsed) {
            model = parsed;
          }
        } else {
          model = {
            providerID: agentDef.model.providerID,
            modelID: agentDef.model.modelID,
          };
        }
      }
    }

    // --- Build & persist resolved state ----------------------------------
    this.state = { agent, model };
    this.persist();
    return { ...this.state };
  }

  // -- internals ----------------------------------------------------------

  private persist(): void {
    this.storage?.save({ ...this.state });
  }
}

function isUserSelectableAgent(agent: AcpAgent): boolean {
  return !agent.hidden && agent.mode !== 'subagent';
}
