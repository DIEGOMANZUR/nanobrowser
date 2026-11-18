import type { ContentSource } from '@src/browser-control';
import { HINDSIGHT_ADD, withConnector } from '@src/store/mcp';
import { workspace, workspacePolicy } from '@src/store/workspace';
import type { Connector, WorkspacePolicy } from '@src/store/workspace';
import { GOOGLE_TOOL_GUIDE, googleCall, googleToken, isGoogleKind } from '@src/store/google-workspace';
import { workspaceResult } from './workspace-actions';
import type { Approve } from './workspace-actions';

function sameConnection(live: Connector | undefined, original: Connector, tool?: string): live is Connector {
  return (
    !!live?.enabled &&
    (!tool || live.tools.includes(tool)) &&
    live.name === original.name &&
    live.endpoint === original.endpoint &&
    live.token === original.token &&
    live.kind === original.kind &&
    live.local === original.local
  );
}

function requiresApproval(policy: WorkspacePolicy, transfer: boolean) {
  if (policy.actions === 'groups') return policy.connectors || (transfer && policy.transfers);
  return transfer && (policy.actions === 'send' || policy.actions === 'chat');
}

function redact(text: string, credential: string) {
  return credential ? text.replaceAll(credential, '[redacted]') : text;
}

export async function connectorAction(
  tool: string,
  data: Record<string, unknown>,
  approve: Approve,
  wrap: (text: string, source: ContentSource) => string,
  signal: AbortSignal,
  chatAsks: () => boolean = () => true,
) {
  if (tool === 'list_connectors') {
    const connectors = (await workspace.connectors())
      .filter(c => c.enabled)
      .map(({ id, name, kind, tools }) => ({
        id,
        name,
        tools: isGoogleKind(kind) ? tools.map(t => ({ name: t, arguments: GOOGLE_TOOL_GUIDE[t] })) : tools,
      }));
    return workspaceResult(connectors, wrap, 'connected tools');
  }
  const id = typeof data.connectorId === 'string' ? data.connectorId : '';
  const name = typeof data.tool === 'string' ? data.tool : '';
  const connector = await workspace.connector(id);
  if (!connector?.enabled) throw new Error('This connector is not enabled.');
  const original = connector;
  async function authorize(action: string, transfer: boolean, details: string, toolName?: string, write = false) {
    const shouldAsk = (policy: WorkspacePolicy) =>
      requiresApproval(policy, transfer) || (write && policy.actions === 'chat' && chatAsks());
    const needsApproval = shouldAsk(await workspacePolicy());
    const destination = original.local ? 'Windows · ' + original.endpoint : redact(original.endpoint, original.token);
    if (
      needsApproval &&
      !(await approve(
        'Usar conector',
        [original.name + ' · ' + action, destination, details].filter(Boolean).join('\n'),
        signal,
      ))
    ) {
      throw new Error('The user declined this connector call. Do not retry without new instructions.');
    }
    const live = await workspace.connector(id);
    if (!sameConnection(live, original, toolName) || (!needsApproval && shouldAsk(await workspacePolicy()))) {
      throw new Error('The user changed the connector or its approval policy.');
    }
    signal.throwIfAborted();
    return live;
  }
  if (tool === 'describe_connector') {
    const kind = connector.kind;
    if (data.tool !== undefined && !connector.tools.includes(name))
      throw new Error('This connector tool is not enabled.');
    const live = isGoogleKind(kind) ? connector : await authorize('Consultar herramientas', false, '');
    const selected = (toolName: string) => live.tools.includes(toolName) && (!name || name === toolName);
    const schema = isGoogleKind(kind)
      ? live.tools.filter(selected).map(name => ({ name, arguments: GOOGLE_TOOL_GUIDE[name] }))
      : await withConnector(live, signal, async client => (await client.list()).filter(t => selected(t.name)));
    const encoded = redact(JSON.stringify(schema), live.token);
    if (encoded.length > 6000 && !name)
      return workspaceResult(
        { tools: live.tools, detail: 'Call describe_connector with one tool name.' },
        wrap,
        'connector schemas',
      );
    return workspaceResult(encoded, wrap, 'connector schemas');
  }
  if (!connector.tools.includes(name)) throw new Error('This connector tool is not enabled.');
  if (typeof data.argumentsJson !== 'string' || data.argumentsJson.length > 64_000)
    throw new Error('Use a JSON object of at most 64,000 characters.');
  let args: unknown;
  try {
    args = JSON.parse(data.argumentsJson);
  } catch {
    throw new Error('Invalid connector arguments. Provide a valid JSON object.');
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid tool arguments.');
  const input = args as Record<string, unknown>;
  const memoryWrite = connector.kind === 'hindsight' && HINDSIGHT_ADD.has(name);
  if (
    memoryWrite &&
    (typeof input.content !== 'string' ||
      !input.content.trim() ||
      input.content.length > 20_000 ||
      Object.keys(input).some(key => !['content', 'context', 'timestamp', 'tags', 'metadata'].includes(key)))
  ) {
    throw new Error('Saving a memory requires new content and cannot target an existing document.');
  }
  const details = redact(data.argumentsJson, connector.token);
  let credential = connector.token;
  let result: unknown;
  if (isGoogleKind(connector.kind)) {
    const transfer = name === 'send_message' || name === 'create_text_file';
    const live = await authorize(name, transfer, details, name, transfer || name === 'create_event');
    credential = await googleToken(live);
    if (!sameConnection(await workspace.connector(id), live, name)) throw new Error('The user changed the connector.');
    result = await googleCall({ ...live, token: credential }, name, input, signal);
  } else {
    // The approval precedes establishing a session. A local server may start when it is initialized.
    const transfer = memoryWrite;
    const live = await authorize(name, transfer, details, name);
    result = await withConnector(live, signal, async client => {
      const tool = (await client.list()).find(t => t.name === name);
      if (!tool || (tool.access === 'add' && !transfer) || !sameConnection(await workspace.connector(id), live, name)) {
        throw new Error('This tool is no longer approved for this connector.');
      }
      return client.call(name, input);
    }).catch(error => {
      throw new Error(redact(error instanceof Error ? error.message : 'Connector request failed.', live.token));
    });
  }
  const serialized = JSON.stringify(result) ?? 'null';
  const sanitized = redact(serialized, credential);
  const output = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
  const cursor =
    typeof output.nextPageToken === 'string'
      ? 'nextPageToken: ' + redact(JSON.stringify(output.nextPageToken.slice(0, 1000)), credential) + '\n'
      : '';
  return workspaceResult(cursor + sanitized, wrap, 'connector result', 'Conector · ' + name);
}
