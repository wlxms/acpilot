/** Copilot-facing model catalog types. */

import type { LanguageModelChatCapabilities } from 'vscode';

/** A model exposed by one backend vendor. */
export interface CopilotModelRegistration {
  readonly vendor: string;
  /** Canonical VS Code model identity, unique within the vendor provider. */
  readonly copilotModelId: string;
  /** Backend-native model identifier. */
  readonly modelId: string;
  /** Backend-native provider/config selector used for invocation routing. */
  readonly providerID: string;
  readonly displayName: string;
  readonly family?: string;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly capabilities: LanguageModelChatCapabilities;
  /** Backend id that owns this registration. */
  readonly backendId: string;
  /** Concrete backend runtime instance that produced this registration. */
  readonly backendInstanceKey: string;
}

export type ResolutionResult =
  | {
      readonly kind: 'backend';
      readonly backendId: string;
      readonly backendInstanceKey: string;
      readonly providerID: string;
      readonly modelID: string;
    }
  | { readonly kind: 'not-found' };
