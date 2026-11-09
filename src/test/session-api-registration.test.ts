import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { ChatSessionCapabilities, ChatSessionContentProvider, ChatSessionItemController } from 'vscode';

describe('latest chat session API registration', () => {
  it('keeps the official content-provider signature', () => {
    const register = vi.fn(() => ({ dispose() {} }));
    const chat = { registerChatSessionContentProvider: register } as unknown as typeof vscode.chat;
    const provider = { provideChatSessionContent: vi.fn() } as unknown as ChatSessionContentProvider;
    const participant = {} as vscode.ChatParticipant;
    const capabilities: ChatSessionCapabilities = { supportsInterruptions: true };

    chat.registerChatSessionContentProvider('acpilot.opencode', provider, participant, capabilities);

    expect(register).toHaveBeenCalledWith('acpilot.opencode', provider, participant, capabilities);
  });

  it('prefers the controller API for session lists and pickers', () => {
    const controller = {} as ChatSessionItemController;
    const createController = vi.fn(() => controller);
    const chat = { createChatSessionItemController: createController } as unknown as typeof vscode.chat;

    const result = chat.createChatSessionItemController('acpilot.dsh', async () => {});

    expect(result).toBe(controller);
    expect(createController).toHaveBeenCalledWith('acpilot.dsh', expect.any(Function));
  });
});
