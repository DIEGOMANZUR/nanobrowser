import type { Result } from '@src/browser-control';
import { nativeFile, nativeRequest } from '@src/store/native-workspace';
import { workspace, workspacePolicy } from '@src/store/workspace';
import { copyWorkspaceFile } from './workspace-files';
import { fileAction, workspaceResult } from './workspace-actions';
import type { Approve } from './workspace-actions';
import type { LayerPort } from '@src/agent/ports';

type Source = { url: string; name: string; pageUrl?: string; started: number; ended: number };

export class PageDownloads {
  #sources = new Map<string, Source>();

  observe(result: Result, started: number) {
    const receipts = result.receipt?.downloads ?? [];
    for (const item of receipts.slice(0, 8)) {
      if (!/^(https?:|blob:https?:)/i.test(item.url)) continue;
      const ref = crypto.randomUUID();
      if (this.#sources.size >= 64) this.#sources.delete(this.#sources.keys().next().value!);
      this.#sources.set(ref, { ...item, pageUrl: result.page?.url, started, ended: Date.now() });
      result.text += '\nObserved page download. Use archive_download with downloadRef ' + ref + '.';
    }
    return result;
  }

  async archive(
    args: Record<string, unknown>,
    approve: Approve,
    wrap: LayerPort['wrap'],
    signal: AbortSignal,
    chatAsks: () => boolean,
  ) {
    const source = typeof args.downloadRef === 'string' ? this.#sources.get(args.downloadRef) : undefined;
    if (!source) throw new Error('Use the downloadRef from this run’s page action.');
    if (!(await chrome.permissions.contains({ permissions: ['downloads', 'nativeMessaging'] })))
      throw new Error('Enable downloads and connect the Windows companion in Settings.');
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    let download: chrome.downloads.DownloadItem;
    for (;;) {
      timeout.throwIfAborted();
      const items = await chrome.downloads.search({
        startedAfter: new Date(source.started - 1500).toISOString(),
        startedBefore: new Date(source.ended + 1500).toISOString(),
        limit: 100,
      });
      if (items.length === 100) throw new Error('Too many concurrent downloads to identify this receipt.');
      const matches = items.filter(
        item =>
          (item.url === source.url || item.finalUrl === source.url) &&
          !item.byExtensionId &&
          (!source.pageUrl || !item.referrer || sameOrigin(item.referrer, source.pageUrl)),
      );
      if (matches.length > 1)
        throw new Error('Several downloads match the receipt. Use the file search to select the intended file.');
      if (matches[0]?.state === 'interrupted') throw new Error('Chrome reported that the download was interrupted.');
      if (matches[0]?.state === 'complete') {
        download = matches[0];
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const actualName = download.filename.split(/[/\\]/).pop();
    if (!actualName || !download.exists || download.danger !== 'safe')
      throw new Error('Chrome has not confirmed a safe local file.');
    // A download reference authorizes this specific source. The existing file policy still governs its destination.
    let folderId = args.folderId;
    let path = args.path;
    if (folderId === undefined && path === undefined) {
      const locations = await nativeRequest<{ downloads: string }>(
        { op: 'workspace-locations', scope: import.meta.env.WXT_AUTORUN_URL ? 'test' : 'personal' },
        signal,
      );
      folderId = 'windows';
      path = locations.downloads + '\\' + actualName;
    }
    if (typeof folderId !== 'string' || typeof path !== 'string')
      throw new Error('Supply both a destination folder id and a filename.');
    if (folderId === 'windows') {
      return fileAction(
        'copy_workspace_file',
        { folderId, path, sourceId: 'workspace:windows:' + download.filename },
        approve,
        wrap,
        signal,
        chatAsks,
      );
    }
    const policy = await workspacePolicy();
    const folder = await workspace.folder(folderId);
    if (!folder || folder.mode !== 'readwrite') throw new Error('Choose an authorized writable folder.');
    if ((policy.actions === 'chat' && chatAsks()) || (policy.actions === 'groups' && policy.files)) {
      if (!(await approve('Guardar descarga', actualName + '\n' + folder.name + ' / ' + path, signal)))
        throw new Error('The user declined archiving this file.');
    }
    const copy = await copyWorkspaceFile({ folderId, path }, await nativeFile(download.filename, signal), signal);
    return workspaceResult(copy, wrap, 'archived page download');
  }
}

function sameOrigin(left: string, right: string) {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}
