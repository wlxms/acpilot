/**
 * Tests for `src/participant/references.ts`.
 *
 * Verifies the split between binary image attachments and plain-text path
 * references — non-image file/directory references must surface as paths
 * (relative to the workspace when possible) rather than being slurped into
 * the prompt as base64 by the opencode backend.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as vscode from 'vscode';
import { extractAttachmentsFromReferences } from './references';
import type { BackendFileAttachment } from '../backend/types';

interface FakeRef {
  id: string;
  value: unknown;
}

function fileRef(fsPath: string): FakeRef {
  return { id: fsPath, value: vscode.Uri.file(fsPath) };
}

function pastedImageRef(mimeType: string, data: Uint8Array): FakeRef {
  return {
    id: 'pasted',
    value: { mimeType, data, reference: vscode.Uri.file('/tmp/pasted.png') },
  };
}

const WORKSPACE = path.resolve('D:/work');

describe('extractAttachmentsFromReferences', () => {
  it('returns empty result for undefined / empty references', () => {
    expect(extractAttachmentsFromReferences(undefined, WORKSPACE)).toEqual({
      attachments: [],
      paths: [],
    });
    expect(extractAttachmentsFromReferences([], WORKSPACE)).toEqual({
      attachments: [],
      paths: [],
    });
  });

  it('emits pasted images as data-URI attachments', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const refs: FakeRef[] = [pastedImageRef('image/png', bytes)];
    const { attachments, paths } = extractAttachmentsFromReferences(refs, WORKSPACE);
    expect(paths).toEqual([]);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].mime).toBe('image/png');
    expect(attachments[0].url).toMatch(/^data:image\/png;base64,/);
  });

  it('emits image files on disk as file:// attachments', () => {
    const refs: FakeRef[] = [fileRef(path.join(WORKSPACE, 'assets/logo.png'))];
    const { attachments, paths } = extractAttachmentsFromReferences(refs, WORKSPACE);
    expect(paths).toEqual([]);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].mime).toBe('image/png');
    expect(attachments[0].url).toMatch(/^file:\/\//);
  });

  it('emits non-image files as relative paths, not attachments', () => {
    const refs: FakeRef[] = [
      fileRef(path.join(WORKSPACE, 'src/main.ts')),
      fileRef(path.join(WORKSPACE, 'README.md')),
    ];
    const { attachments, paths } = extractAttachmentsFromReferences(refs, WORKSPACE);
    expect(attachments).toEqual([]);
    expect(paths).toHaveLength(2);
    expect(paths.some((p) => p.endsWith(path.join('src', 'main.ts')))).toBe(true);
    expect(paths.some((p) => p.endsWith('README.md'))).toBe(true);
  });

  it('emits files outside the workspace as absolute paths', () => {
    const outside = path.resolve('D:/elsewhere/notes.txt');
    const refs: FakeRef[] = [fileRef(outside)];
    const { attachments, paths } = extractAttachmentsFromReferences(refs, WORKSPACE);
    expect(attachments).toEqual([]);
    expect(paths).toEqual([outside]);
  });

  it('emits absolute paths when no workspace directory is known', () => {
    const abs = path.join(WORKSPACE, 'src/main.ts');
    const refs: FakeRef[] = [fileRef(abs)];
    const { attachments, paths } = extractAttachmentsFromReferences(refs, undefined);
    expect(attachments).toEqual([]);
    expect(paths).toEqual([abs]);
  });

  it('emits directories (no extension) as paths', () => {
    const refs: FakeRef[] = [fileRef(path.join(WORKSPACE, 'src'))];
    const { attachments, paths } = extractAttachmentsFromReferences(refs, WORKSPACE);
    expect(attachments).toEqual([]);
    expect(paths).toEqual(['src']);
  });

  it('deduplicates identical references', () => {
    const refs: FakeRef[] = [
      fileRef(path.join(WORKSPACE, 'src/main.ts')),
      fileRef(path.join(WORKSPACE, 'src/main.ts')),
    ];
    const { paths } = extractAttachmentsFromReferences(refs, WORKSPACE);
    expect(paths).toHaveLength(1);
  });

  it('separates images and paths in a mixed reference list', () => {
    const refs: FakeRef[] = [
      pastedImageRef('image/jpeg', new Uint8Array([9, 9, 9])),
      fileRef(path.join(WORKSPACE, 'diagram.png')),
      fileRef(path.join(WORKSPACE, 'src/index.ts')),
      fileRef(path.join(WORKSPACE, 'package.json')),
    ];
    const { attachments, paths } = extractAttachmentsFromReferences(refs, WORKSPACE);
    expect(attachments).toHaveLength(2);
    const attachmentMimes = attachments.map((a: BackendFileAttachment) => a.mime).sort();
    expect(attachmentMimes).toEqual(['image/jpeg', 'image/png']);
    expect(paths).toHaveLength(2);
    expect(paths.some((p) => p.endsWith(path.join('src', 'index.ts')))).toBe(true);
    expect(paths.some((p) => p.endsWith('package.json'))).toBe(true);
  });
});
