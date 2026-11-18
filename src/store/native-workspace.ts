import { base64 } from '@src/agent/attachments';

const HOST = 'local.nanobrowser.workspace';

interface NativeResponse<T> {
  data?: T;
  error?: string;
}

export function nativeRequest<T>(request: Record<string, unknown>, userSignal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(20_000);
  const session = openNativeSession(userSignal ? AbortSignal.any([timeout, userSignal]) : timeout);
  return session.send<T>(request).finally(session.close);
}

export function openNativeSession(signal: AbortSignal) {
  signal.throwIfAborted();
  const port = chrome.runtime.connectNative(HOST);
  let waiting: { resolve: (value: unknown) => void; reject: (error: unknown) => void } | undefined;
  let closed: Error | undefined;
  const close = () => {
    signal.removeEventListener('abort', abort);
    port.disconnect();
    closed ??= new Error('The Windows session was closed.');
    waiting?.reject(closed);
    waiting = undefined;
  };
  const abort = () => {
    waiting?.reject(signal.reason);
    close();
  };
  signal.addEventListener('abort', abort, { once: true });
  port.onDisconnect.addListener(() => {
    closed = new Error(chrome.runtime.lastError?.message ?? 'El componente de Windows dejó de responder.');
    close();
  });
  port.onMessage.addListener((message: NativeResponse<unknown>) => {
    const current = waiting;
    waiting = undefined;
    if (message.error || !('data' in message))
      current?.reject(new Error(message.error ?? 'Respuesta inválida de Windows.'));
    else current?.resolve(message.data);
  });
  return {
    close,
    async send<T>(request: Record<string, unknown>): Promise<T> {
      if (closed) throw closed;
      signal.throwIfAborted();
      if (waiting) throw new Error('This Windows session already has a pending operation.');
      return new Promise((resolve, reject) => {
        waiting = { resolve: value => resolve(value as T), reject };
        try {
          port.postMessage(request);
        } catch (error) {
          waiting = undefined;
          reject(error);
        }
      });
    },
  };
}

interface Chunk {
  name: string;
  size: number;
  data: string;
  modified: string;
}

export async function nativeFile(path: string, userSignal: AbortSignal): Promise<File> {
  const signal = AbortSignal.any([userSignal, AbortSignal.timeout(45_000)]);
  const session = openNativeSession(signal);
  try {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    const first = await session.send<Chunk>({ op: 'chunk', path, offset: 0 });
    let part = first;
    let offset = 0;
    while (offset < first.size) {
      if (part.size !== first.size || part.modified !== first.modified || !part.data) {
        throw new Error('The file changed while reading it. Find the file again before retrying.');
      }
      const bytes = Uint8Array.from(atob(part.data), char => char.charCodeAt(0));
      chunks.push(bytes);
      offset += bytes.length;
      if (offset < first.size) part = await session.send<Chunk>({ op: 'chunk', path, offset });
    }
    if (offset !== first.size) throw new Error('The file size changed.');
    return new File(chunks, first.name);
  } finally {
    session.close();
  }
}

export async function nativeUpload(path: string, signal: AbortSignal) {
  const file = await nativeFile(path, signal);
  if (!file.size) throw new Error('Choose a nonempty file.');
  return { name: file.name, mimeType: 'application/octet-stream', base64: await base64(file) };
}
