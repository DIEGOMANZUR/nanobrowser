import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectorAction } from '../connectors';
import { workspace, DEFAULT_WORKSPACE_POLICY, WORKSPACE_POLICY_KEY } from '@src/store/workspace';
import type { Connector } from '@src/store/workspace';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const cases: Array<[Connector['kind'], string, Record<string, unknown>, string, string]> = [
  ['gmail', 'list_messages', { q: 'test' }, 'GET', '/gmail/v1/users/me/messages'],
  ['gmail', 'get_message', { id: 'fixture' }, 'GET', '/gmail/v1/users/me/messages/fixture'],
  [
    'gmail',
    'send_message',
    { to: 'test@example.invalid', subject: 'Fixture', body: 'Contenido de prueba' },
    'POST',
    '/gmail/v1/users/me/messages/send',
  ],
  ['calendar', 'list_calendars', {}, 'GET', '/calendar/v3/users/me/calendarList'],
  ['calendar', 'list_events', {}, 'GET', '/calendar/v3/calendars/primary/events'],
  [
    'calendar',
    'create_event',
    { title: 'Fixture', start: '2026-11-20T12:30:00Z', end: '2026-11-20T13:00:00Z' },
    'POST',
    '/calendar/v3/calendars/primary/events',
  ],
  ['drive', 'list_files', {}, 'GET', '/drive/v3/files'],
  ['drive', 'get_file_metadata', { id: 'test-file' }, 'GET', '/drive/v3/files/test-file'],
  ['drive', 'create_text_file', { name: 'fixture.md', text: 'contenido' }, 'POST', '/upload/drive/v3/files'],
];

function service(kind: Connector['kind'], tool: string) {
  const connector: Connector = {
    id: 'test',
    name: 'Fixture service',
    kind,
    enabled: true,
    token: 'fixture-only',
    endpoint: 'https://example.invalid/mcp',
    tools: [tool],
  };
  vi.spyOn(workspace, 'connector').mockResolvedValue(connector);
  vi.stubGlobal('chrome', {
    storage: {
      local: { get: async () => ({ [WORKSPACE_POLICY_KEY]: { ...DEFAULT_WORKSPACE_POLICY, actions: 'groups' } }) },
    },
  });
  return connector;
}

describe('Configured connector workflows', () => {
  it.each(cases)('%s executes %s using the configured adapter', async (kind, tool, input, method, path) => {
    service(kind, tool);
    const fetch = vi.fn(async () => Response.json({ id: 'fixture-result' }));
    vi.stubGlobal('fetch', fetch);
    const approve = vi.fn(async () => true);
    const result = await connectorAction(
      'call_connector',
      { connectorId: 'test', tool, argumentsJson: JSON.stringify(input) },
      approve,
      text => text,
      new AbortController().signal,
    );
    expect(result.text).toContain('fixture-result');
    expect(approve).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(path),
      expect.objectContaining({ method, redirect: 'error' }),
    );
  });

  it.each([
    ['googleAds', 'search_search', { query: 'SELECT campaign.id FROM campaign' }],
    ['hindsight', 'retain', { content: 'A synthetic reusable fact.' }],
    ['hindsight', 'recall', { query: 'synthetic' }],
  ] as const)('discovers and calls %s/%s', async (kind, tool, input) => {
    service(kind, tool);
    const methods: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, options: RequestInit) => {
        const req = JSON.parse(String(options.body));
        methods.push(req.method);
        if (req.method === 'notifications/initialized') return new Response(null, { status: 202 });
        const result =
          req.method === 'initialize'
            ? { protocolVersion: '2025-06-18' }
            : req.method === 'tools/list'
              ? { tools: [{ name: tool, inputSchema: { type: 'object' } }] }
              : { structuredContent: { fixture: 'received', args: req.params.arguments } };
        return Response.json({ jsonrpc: '2.0', id: req.id, result });
      }),
    );
    const result = await connectorAction(
      'call_connector',
      { connectorId: 'test', tool, argumentsJson: JSON.stringify(input) },
      async () => true,
      text => text,
      new AbortController().signal,
    );
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    expect(result.text).toContain('received');
  });
});
