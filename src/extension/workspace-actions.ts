import type { ContentSource, WriteDecision, WriteQuestion } from '@src/browser-control';
import { workspace, workspacePolicy } from '@src/store/workspace';
import type { WorkspacePolicy } from '@src/store/workspace';
import { nativeFile, nativeRequest, nativeUpload } from '@src/store/native-workspace';
import {
  browseFiles,
  copyWorkspaceFile,
  readFileText,
  readText,
  saveWorkspaceFile,
  workspaceFileById,
  workspaceUpload,
} from './workspace-files';

export type Approve = (title: string, detail: string, signal: AbortSignal) => Promise<boolean>;
type Wrap = (text: string, source: ContentSource) => string;

export function actionDecision(policy: WorkspacePolicy, request: WriteQuestion, old: WriteDecision): WriteDecision {
  const ask: WriteDecision = { decision: 'ask', canRemember: false };
  const run: WriteDecision = { decision: 'run', canRemember: false, by: 'auto' };
  if (request.category === 'delete') return { decision: 'block', canRemember: false };
  if (policy.actions === 'chat') return old;
  if (old.decision === 'ask' && old.by === 'site-rule') return ask;
  const sends =
    request.category === 'upload' ||
    /\b(send|enviar|envoyer|senden)\b|发送|傳送/i.test(request.target ?? '') ||
    request.site === 'mail.google.com';
  if (policy.actions === 'groups') return (sends ? policy.transfers : policy.browser) ? ask : run;
  return policy.actions === 'send' && sends ? ask : run;
}

function parent(path: string): string {
  const index = path.replaceAll('/', '\\').lastIndexOf('\\');
  return path.slice(0, Math.max(3, index));
}

function drivePath(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z]:[/\\]/i.test(value) || value.length > 245) {
    throw new Error('Use the absolute path of a Windows drive.');
  }
  return value;
}

async function allowPath(path: string, policy: WorkspacePolicy, approve: Approve, signal: AbortSignal) {
  if (policy.access === 'folders') throw new Error('Enable Windows access in Settings or use an authorized folder.');
  if (policy.access === 'ask' && !(await approve('Acceso a archivos de Windows', path, signal))) {
    throw new Error('The user declined this Windows access. Do not retry it without new instructions.');
  }
  if ((await workspacePolicy()).access !== policy.access) throw new Error('The user changed the Windows access mode.');
  signal.throwIfAborted();
}

export async function resolveWorkspaceUpload(id: string, approve: Approve, signal: AbortSignal) {
  if (!id.startsWith('workspace:windows:')) return workspaceUpload(id, signal);
  const path = drivePath(id.slice('workspace:windows:'.length));
  await allowPath(parent(path), await workspacePolicy(), approve, signal);
  return nativeUpload(path, signal);
}

async function sourceFile(id: unknown, policy: WorkspacePolicy, approve: Approve, signal: AbortSignal) {
  if (typeof id !== 'string' || !id.startsWith('workspace:windows:')) return workspaceFileById(id, signal);
  const path = drivePath(id.slice('workspace:windows:'.length));
  await allowPath(parent(path), policy, approve, signal);
  return nativeFile(path, signal);
}

export function workspaceResult(data: unknown, wrap: Wrap, source: string, details?: string) {
  const content = JSON.stringify(data, (_, value) => (typeof value === 'string' ? value.slice(0, 5000) : value));
  return {
    text: (details ? details + '\n' : '') + wrap((content ?? 'null').slice(0, 6500), { attachment: source }),
    isError: false,
  };
}

export async function fileAction(
  tool: string,
  args: Record<string, unknown>,
  approve: Approve,
  wrap: Wrap,
  signal: AbortSignal,
) {
  const policy = await workspacePolicy();
  const run = async () => {
    if (tool === 'list_workspace_folders') {
      const local = (await workspace.folders()).map(({ id, name, mode }) => ({ id, name, mode }));
      if (policy.access === 'folders') return { folders: local };
      await allowPath('Unidades conectadas y carpetas conocidas', policy, approve, signal);
      const roots = await nativeRequest({ op: 'roots' }, signal);
      return { folders: local, windows: { id: 'windows', roots } };
    }
    const windows = args.folderId === 'windows';
    const path = windows ? drivePath(args.path) : args.path;
    const writing = tool === 'save_workspace_file' || tool === 'copy_workspace_file';
    if (windows)
      await allowPath(tool === 'browse_workspace' ? String(path) : parent(String(path)), policy, approve, signal);
    if (
      writing &&
      policy.actions === 'groups' &&
      policy.files &&
      !(await approve('Crear un archivo', String(path), signal))
    ) {
      throw new Error('The user declined this file creation. Do not retry it.');
    }
    if (tool === 'browse_workspace') {
      if (!windows) return browseFiles(args, signal);
      const result = await nativeRequest<{ entries: { path: string; kind: string }[] }>(
        { op: 'list', path, query: args.query, offset: args.offset },
        signal,
      );
      return {
        ...result,
        entries: result.entries.map(entry => ({
          ...entry,
          ...(entry.kind === 'file' && { uploadId: 'workspace:windows:' + entry.path }),
        })),
      };
    }
    if (tool === 'read_workspace_file') {
      return windows ? readText(await nativeFile(String(path), signal), args.offset) : readFileText(args, signal);
    }
    if (tool === 'save_workspace_file') {
      if (typeof args.content !== 'string' || new TextEncoder().encode(args.content).length > 5 * 1024 * 1024) {
        throw new Error('Use at most 5 MiB of text.');
      }
      return windows
        ? nativeRequest({ op: 'save', path, content: args.content }, signal)
        : saveWorkspaceFile(args, signal);
    }
    if (tool === 'copy_workspace_file') {
      if (windows && typeof args.sourceId === 'string' && args.sourceId.startsWith('workspace:windows:')) {
        const source = drivePath(args.sourceId.slice('workspace:windows:'.length));
        await allowPath(parent(source), policy, approve, signal);
        return nativeRequest({ op: 'copy', path, source }, signal);
      }
      if (windows)
        throw new Error(
          'Use a Windows source path for this Windows destination, or save to a connected writable folder.',
        );
      return copyWorkspaceFile(args, await sourceFile(args.sourceId, policy, approve, signal), signal);
    }
    throw new Error('Unknown file operation.');
  };
  const result = await run();
  const saved = result as { path?: string; bytes?: number };
  const details =
    saved.path && typeof saved.bytes === 'number'
      ? 'Guardado · ' + saved.path.replace(/[\r\n]/g, ' ') + ' · ' + saved.bytes + ' bytes'
      : undefined;
  return workspaceResult(result, wrap, 'workspace', details);
}
