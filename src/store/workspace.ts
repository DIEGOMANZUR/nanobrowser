import { openDB } from 'idb';
import type { DBSchema } from 'idb';

export type FolderMode = 'read' | 'readwrite';

export interface WorkspaceFolder {
  id: string;
  name: string;
  mode: FolderMode;
  handle: WorkspaceDirectory;
}

export interface WorkspaceDirectory extends FileSystemDirectoryHandle {
  queryPermission(options: { mode: FolderMode }): Promise<PermissionState>;
  requestPermission(options: { mode: FolderMode }): Promise<PermissionState>;
}

export interface Connector {
  id: string;
  name: string;
  endpoint: string;
  token: string;
  tools: string[];
  enabled: boolean;
  kind?: 'mcp' | 'googleAds' | 'hindsight' | 'gmail' | 'calendar' | 'drive';
  local?: boolean;
}

export interface WorkspacePolicy {
  access: 'folders' | 'ask' | 'full';
  actions: 'chat' | 'auto' | 'send' | 'groups';
  browser: boolean;
  files: boolean;
  connectors: boolean;
  transfers: boolean;
  unlimited: boolean;
}

export const DEFAULT_WORKSPACE_POLICY: WorkspacePolicy = {
  access: 'folders',
  actions: 'chat',
  browser: true,
  files: true,
  connectors: true,
  transfers: true,
  unlimited: false,
};

export const WORKSPACE_POLICY_KEY = 'nb.workspacePolicy';
export const WORKSPACE_POLICY_REQUEST = 'nb.workspacePolicy.patch';

export async function workspacePolicy(): Promise<WorkspacePolicy> {
  const saved = await chrome.storage.local.get(WORKSPACE_POLICY_KEY);
  return { ...DEFAULT_WORKSPACE_POLICY, ...(saved[WORKSPACE_POLICY_KEY] as Partial<WorkspacePolicy> | undefined) };
}

export async function updateWorkspacePolicy(policy: WorkspacePolicy) {
  await chrome.storage.local.set({ [WORKSPACE_POLICY_KEY]: policy });
}

let policyWrites: Promise<unknown> = Promise.resolve();
export function patchWorkspacePolicy(update: Partial<WorkspacePolicy>) {
  const saved = policyWrites.then(async () => {
    const policy = { ...(await workspacePolicy()), ...update };
    await updateWorkspacePolicy(policy);
    return policy;
  });
  policyWrites = saved.catch(() => undefined);
  return saved;
}

interface WorkspaceDb extends DBSchema {
  folders: { key: string; value: WorkspaceFolder };
  connectors: { key: string; value: Connector };
}

let pending: ReturnType<typeof openDB<WorkspaceDb>> | undefined;
function db() {
  return (pending ??= openDB<WorkspaceDb>('nanobrowser-workspace', 1, {
    upgrade(database) {
      database.createObjectStore('folders', { keyPath: 'id' });
      database.createObjectStore('connectors', { keyPath: 'id' });
    },
  }));
}

export const workspace = {
  folders: async () => (await db()).getAll('folders'),
  folder: async (id: string) => (await db()).get('folders', id),
  putFolder: async (folder: WorkspaceFolder) => (await db()).put('folders', folder),
  forgetFolder: async (id: string) => (await db()).delete('folders', id),
  connectors: async () => (await db()).getAll('connectors'),
  connector: async (id: string) => (await db()).get('connectors', id),
  putConnector: async (connector: Connector) => (await db()).put('connectors', connector),
  clear: async () => {
    const transaction = (await db()).transaction(['folders', 'connectors'], 'readwrite');
    await Promise.all([
      transaction.objectStore('folders').clear(),
      transaction.objectStore('connectors').clear(),
      transaction.done,
    ]);
  },
};
