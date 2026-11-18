import type { Connector } from './workspace';
import { openNativeSession } from './native-workspace';

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_TOOLS = 100;
const GOOGLE_ADS_READ = new Set([
  'search_search',
  'metadata_get_resource_metadata',
  'customers_list_accessible_customers',
]);
const HINDSIGHT_READ = new Set(['recall', 'reflect', 'hindsight_recall', 'hindsight_reflect']);
export const HINDSIGHT_ADD = new Set(['retain', 'sync_retain']);
export const ADD_TOOL_NAME = /^(add|append|create|insert|send|submit|upload)(?:[_.-]|[A-Z]|$)/;

export interface RemoteTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export function connectorEndpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('Use an HTTPS server address without credentials or a fragment.');
  }
  return url.href;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function allowedTool(item: unknown, kind: Connector['kind'], allowAdds: boolean): RemoteTool | undefined {
  const tool = record(item);
  const hints = record(tool?.annotations);
  const schema = record(tool?.inputSchema);
  if (
    typeof tool?.name !== 'string' ||
    !/^[\w.-]{1,128}$/.test(tool.name) ||
    /delete|remove|trash|purge|erase|destroy|clear|write|update|execute|command/i.test(tool.name) ||
    hints?.destructiveHint === true ||
    schema?.type !== 'object'
  )
    return undefined;
  const read =
    kind === 'googleAds'
      ? GOOGLE_ADS_READ.has(tool.name)
      : kind === 'hindsight'
        ? HINDSIGHT_READ.has(tool.name) || hints?.readOnlyHint === true
        : hints?.readOnlyHint === true;
  const add =
    (kind === 'hindsight' && HINDSIGHT_ADD.has(tool.name)) ||
    ((!kind || kind === 'mcp') && allowAdds && hints?.destructiveHint === false && ADD_TOOL_NAME.test(tool.name));
  if (!read && !add) return undefined;
  return {
    name: tool.name,
    description: typeof tool.description === 'string' ? tool.description.slice(0, 250) : undefined,
    inputSchema: schema,
  };
}

async function responseObject(response: Response, id: number) {
  const type = response.headers.get('content-type') ?? '';
  if (!/^application\/json\b|^text\/event-stream\b/i.test(type)) throw new Error('Unexpected connector response type.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The connector response has no body.');
  let size = 0;
  let buffer = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      size += value?.byteLength ?? 0;
      if (size > MAX_RESPONSE_BYTES) throw new Error('The connector response is too large.');
      buffer += value ? decoder.decode(value, { stream: true }) : decoder.decode();
      if (type.toLowerCase().startsWith('text/event-stream')) {
        let split = /\r?\n\r?\n/.exec(buffer);
        while (split) {
          const data = buffer
            .slice(0, split.index)
            .split(/\r?\n/)
            .filter(line => line.startsWith('data:'));
          buffer = buffer.slice(split.index + split[0].length);
          if (data.length) {
            const message = record(JSON.parse(data.map(line => line.slice(5).replace(/^ /, '')).join('\n')));
            if (message?.id === id && ('result' in message || 'error' in message)) return message;
          }
          split = /\r?\n\r?\n/.exec(buffer);
        }
      }
      if (done) break;
    }
    if (type.toLowerCase().startsWith('application/json')) {
      const message = record(JSON.parse(buffer));
      if (message?.id === id) return message;
    }
    throw new Error('The connector did not return a matching response.');
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function withConnector<T>(
  connector: Pick<Connector, 'endpoint' | 'token' | 'local' | 'kind' | 'allowAdds'>,
  userSignal: AbortSignal,
  run: (client: {
    list: () => Promise<RemoteTool[]>;
    call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  }) => Promise<T>,
): Promise<T> {
  const signal = AbortSignal.any([userSignal, AbortSignal.timeout(20_000)]);
  const endpoint = connector.local ? connector.endpoint : connectorEndpoint(connector.endpoint);
  if (connector.local && !/^[A-Za-z0-9_-]{1,64}$/.test(endpoint)) throw new Error('Invalid local connector name.');
  const native = connector.local ? openNativeSession(signal) : undefined;
  const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' });
  if (connector.token) headers.set('Authorization', 'Bearer ' + connector.token);
  let sequence = 0;

  async function send(method: string, params: unknown, notification = false) {
    const id = ++sequence;
    const body = JSON.stringify({ jsonrpc: '2.0', ...(!notification && { id }), method, params });
    if (native) {
      const reply = await native.send<unknown>({ op: 'mcp', server: endpoint, message: body });
      if (notification) return undefined;
      const result = record(reply);
      if (result?.jsonrpc !== '2.0' || result.id !== id || 'error' in result || !('result' in result)) {
        throw new Error('The local connector rejected ' + method + '.');
      }
      return result.result;
    }
    const response = await fetch(endpoint, {
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      headers,
      signal,
      body,
    });
    if (!response.ok || (notification && response.status !== 202)) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error('The connector returned status ' + response.status + '.');
    }
    if (notification) return undefined;
    const message = await responseObject(response, id);
    if (message.jsonrpc !== '2.0' || 'error' in message || !('result' in message)) {
      throw new Error('The connector rejected ' + method + '.');
    }
    if (method === 'initialize') {
      const session = response.headers.get('Mcp-Session-Id');
      if (session) headers.set('Mcp-Session-Id', session);
    }
    return message.result;
  }

  try {
    const initialized = record(
      await send('initialize', {
        protocolVersion: PROTOCOLS[0],
        capabilities: {},
        clientInfo: { name: 'Nanobrowser Workspace', version: '0.1.0' },
      }),
    );
    const version = initialized?.protocolVersion;
    if (typeof version !== 'string' || !PROTOCOLS.includes(version))
      throw new Error('Unsupported connector protocol version.');
    headers.set('MCP-Protocol-Version', version);
    await send('notifications/initialized', undefined, true);

    return await run({
      async list() {
        const tools: RemoteTool[] = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = record(await send('tools/list', cursor ? { cursor } : {}));
          if (!Array.isArray(page?.tools)) throw new Error('The connector returned an invalid tool list.');
          for (const item of page.tools) {
            const tool = allowedTool(item, connector.kind, !!connector.allowAdds);
            if (tool) tools.push(tool);
            if (tools.length >= MAX_TOOLS) return tools;
          }
          cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
          if (cursor && (cursors.has(cursor) || cursors.size >= 9))
            throw new Error('The connector tool list could not be completed.');
          if (cursor) cursors.add(cursor);
        } while (cursor);
        return tools;
      },
      async call(name, args) {
        const result = record(await send('tools/call', { name, arguments: args }));
        if (!result || result.isError === true) throw new Error('The remote tool returned an error.');
        return result.structuredContent ?? result.content;
      },
    });
  } finally {
    if (native) {
      await native.send({ op: 'mcp-close' }).catch(() => undefined);
      native.close();
    }
  }
}
