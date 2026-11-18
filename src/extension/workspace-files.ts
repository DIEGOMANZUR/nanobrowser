import { attachmentKind, MAX_FILE } from '@src/store/attachments';
import { workspace } from '@src/store/workspace';
import type { FolderMode, WorkspaceDirectory } from '@src/store/workspace';
import { base64 } from '@src/agent/attachments';
import { checkSave, SAVE_TYPES } from '@src/agent/save-file';

const PAGE_SIZE = 25;
const SCAN_LIMIT = 10_000;

export function pathParts(input: unknown, rootAllowed: boolean): string[] {
  if ((input === '' || input === undefined) && rootAllowed) return [];
  if (typeof input !== 'string' || input.length > 700) throw new Error('Use a relative path inside the folder.');
  const parts = input.split('/');
  const invalid = parts.some(part => {
    // Reject traversal, alternate data streams and Windows device names.
    return (
      !part ||
      part.startsWith('.') ||
      part.trim() !== part ||
      part.endsWith('.') ||
      /[\\:*?"<>|]/.test(part) ||
      [...part].some(char => char.charCodeAt(0) < 32) ||
      /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)
    );
  });
  if (invalid || parts.length > 12) throw new Error('Use ordinary names separated by / inside the authorized folder.');
  return parts;
}

async function root(id: unknown, mode: FolderMode): Promise<WorkspaceDirectory> {
  const folder = typeof id === 'string' ? await workspace.folder(id) : undefined;
  if (!folder) throw new Error('This folder is not connected. Open Settings → Carpetas y conectores.');
  if (mode === 'readwrite' && folder.mode !== mode) throw new Error('This folder is read-only.');
  if ((await folder.handle.queryPermission({ mode })) !== 'granted') {
    throw new Error('Open Settings → Carpetas y conectores and press Reactivar for this folder.');
  }
  return folder.handle;
}

async function directory(handle: WorkspaceDirectory, parts: string[], signal: AbortSignal, create = false) {
  let current = handle;
  for (const part of parts) {
    signal.throwIfAborted();
    current = (await current.getDirectoryHandle(part, { create })) as WorkspaceDirectory;
  }
  return current;
}

export async function getFile(folderId: unknown, path: unknown, signal: AbortSignal): Promise<File> {
  const parts = pathParts(path, false);
  const name = parts.pop()!;
  const parent = await directory(await root(folderId, 'read'), parts, signal);
  return (await parent.getFileHandle(name)).getFile();
}

function offsetOf(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export async function browseFiles(args: Record<string, unknown>, signal: AbortSignal) {
  const parts = pathParts(args.path, true);
  const folder = await directory(await root(args.folderId, 'read'), parts, signal);
  const query = typeof args.query === 'string' ? args.query.slice(0, 200).toLowerCase() : '';
  const offset = offsetOf(args.offset);
  const entries = [];
  let scanned = 0;
  let matched = 0;
  for await (const entry of folder.values()) {
    signal.throwIfAborted();
    if (++scanned > SCAN_LIMIT) return { entries, limited: true };
    if (entry.name.startsWith('.') || !entry.name.toLowerCase().includes(query)) continue;
    if (matched++ < offset) continue;
    if (entries.length >= PAGE_SIZE) return { entries, nextOffset: offset + entries.length };
    const path = [...parts, entry.name].join('/');
    if (entry.kind === 'directory') {
      entries.push({ kind: entry.kind, path });
    } else {
      const file = await (entry as FileSystemFileHandle).getFile().catch(() => null);
      entries.push({
        kind: entry.kind,
        path,
        ...(file && {
          size: file.size,
          modified: new Date(file.lastModified).toISOString(),
          uploadId: 'workspace:' + String(args.folderId) + ':' + path,
        }),
      });
    }
  }
  return { entries };
}

export async function readFileText(args: Record<string, unknown>, signal: AbortSignal) {
  const file = await getFile(args.folderId, args.path, signal);
  return readText(file, args.offset);
}

export async function readText(file: File, start: unknown) {
  const kind = attachmentKind(file.name, file.type);
  if (!('kind' in kind) || kind.kind !== 'text') throw new Error('This tool reads text files only.');
  if (file.size > MAX_FILE) throw new Error('The file exceeds the 25 MiB reading limit.');
  const text = await file.text();
  const offset = Math.min(offsetOf(start), text.length);
  const end = Math.min(offset + 4000, text.length);
  return { name: file.name, text: text.slice(offset, end), ...(end < text.length && { nextOffset: end }) };
}

export async function workspaceUpload(id: string, signal: AbortSignal) {
  const file = await workspaceFileById(id, signal);
  if (!file.size || file.size > MAX_FILE) throw new Error('Each upload needs a nonempty file of at most 25 MiB.');
  signal.throwIfAborted();
  return { name: file.name, mimeType: file.type || 'application/octet-stream', base64: await base64(file) };
}

export async function workspaceFileById(id: unknown, signal: AbortSignal) {
  const match = typeof id === 'string' ? /^workspace:([a-f0-9-]{36}):(.+)$/i.exec(id) : null;
  if (!match) throw new Error('Use an uploadId returned by browse_workspace.');
  return getFile(match[1], match[2], signal);
}

export async function saveWorkspaceFile(args: Record<string, unknown>, signal: AbortSignal) {
  const parts = pathParts(args.path, false);
  const filename = parts.pop()!;
  const dot = filename.lastIndexOf('.');
  const mimeType = dot > 0 ? SAVE_TYPES[filename.slice(dot + 1).toLowerCase()] : undefined;
  const checked = checkSave({ filename, content: args.content, mimeType });
  if (!checked.ok) throw new Error(checked.reason);
  return writeNewWorkspaceFile(args.folderId, parts, filename, new Blob([args.content as string]), signal);
}

export async function copyWorkspaceFile(args: Record<string, unknown>, file: File, signal: AbortSignal) {
  const parts = pathParts(args.path, false);
  const filename = parts.pop()!;
  const extension = (name: string) => /\.[^.]+$/.exec(name.toLowerCase())?.[0];
  if (extension(file.name) !== extension(filename)) throw new Error('Keep the original file extension when copying.');
  if (file.size > MAX_FILE || filename.length > 120) throw new Error('The file or destination name is too large.');
  return writeNewWorkspaceFile(args.folderId, parts, filename, file, signal);
}

async function writeNewWorkspaceFile(
  folderId: unknown,
  parts: string[],
  filename: string,
  data: Blob,
  signal: AbortSignal,
) {
  const folder = await directory(await root(folderId, 'readwrite'), parts, signal, true);
  const dot = filename.lastIndexOf('.') > 0 ? filename.lastIndexOf('.') : filename.length;
  // The picker handles have no create-exclusive flag. Use an unpredictable name and refuse a collision.
  const name = filename.slice(0, dot) + ' (' + crypto.randomUUID() + ')' + filename.slice(dot);
  try {
    await folder.getFileHandle(name);
    throw new Error('The new file name is already in use.');
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error;
  }
  signal.throwIfAborted();
  const handle = await folder.getFileHandle(name, { create: true });
  const stream = await handle.createWritable({ keepExistingData: true });
  try {
    if ((await handle.getFile()).size) throw new Error('The new file name is already in use.');
    signal.throwIfAborted();
    await stream.write(data);
    signal.throwIfAborted();
    await stream.close();
  } catch (error) {
    await stream.abort().catch(() => undefined);
    throw error;
  }
  return { path: [...parts, name].join('/'), bytes: data.size };
}
