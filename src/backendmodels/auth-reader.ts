/**
 * OpenCode auth.json reader.
 *
 * Reads the canonical auth storage file so ACPModels can determine
 * which providers have credentials available. The write path is
 * handled by sync-engine via the v2 SDK (`client.auth.set`).
 *
 * @module
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { BackendAuthEntry, AcpAuthType } from './types';

// ===========================================================================
// Path resolution
// ===========================================================================

/** Resolve the cross-platform path to OpenCode's auth.json */
export function resolveAuthPath(): string {
  if (process.env.OPENCODE_AUTH_PATH) {
    return process.env.OPENCODE_AUTH_PATH;
  }
  // XDG-style path (consistent across all platforms for npm-installed opencode)
  return path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
}

// ===========================================================================
// Reader
// ===========================================================================

export class AuthReader {
  private cache: Record<string, BackendAuthEntry> = {};

  /** Load the full auth.json content into memory */
  async load(): Promise<Record<string, BackendAuthEntry>> {
    try {
      const raw = await fs.readFile(resolveAuthPath(), 'utf-8');
      const parsed: Record<string, unknown> = JSON.parse(raw);
      this.cache = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'object' && value !== null) {
          const v = value as Record<string, unknown>;
          if (typeof v.type === 'string') {
            this.cache[key] = {
              type: v.type as AcpAuthType,
              key: typeof v.key === 'string' ? v.key : undefined,
              access: typeof v.access === 'string' ? v.access : undefined,
              refresh: typeof v.refresh === 'string' ? v.refresh : undefined,
              expires: typeof v.expires === 'number' ? v.expires : undefined,
            };
          }
        }
      }
      return this.cache;
    } catch {
      this.cache = {};
      return {};
    }
  }

  /** Get the plaintext API key for a provider, if available */
  getApiKey(providerID: string): string | undefined {
    const entry = this.cache[providerID];
    if (!entry) return undefined;
    if (entry.type === 'api' && entry.key) return entry.key;
    if (entry.type === 'oauth' && entry.access) return entry.access;
    if (entry.type === 'wellknown' && entry.key) return entry.key;
    return undefined;
  }

  /** Check whether a provider has any usable credential */
  hasKey(providerID: string): boolean {
    return this.getApiKey(providerID) !== undefined;
  }

  /** Return all provider IDs that have credentials */
  getCredentialedProviders(): string[] {
    return Object.keys(this.cache).filter((id) => this.hasKey(id));
  }

  /** Return the full in-memory cache */
  getAll(): Record<string, BackendAuthEntry> {
    return { ...this.cache };
  }
}
