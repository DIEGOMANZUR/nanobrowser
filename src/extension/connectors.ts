import type { ContentSource } from '@src/browser-control';
import { ADD_TOOL_NAME, HINDSIGHT_ADD, withConnector } from '@src/store/mcp';
import { workspace, workspacePolicy } from '@src/store/workspace';
import { GOOGLE_TOOL_GUIDE, googleCall, googleToken, isGoogleKind } from '@src/store/google-workspace';
import { workspaceResult } from './workspace-actions';
import type { Approve } from './workspace-actions';

export async function connectorAction(
  tool: string,
  data: Record<string, unknown>,
  approve: Approve,
  wrap: (text: string, source: ContentSource) => string,
  signal: AbortSignal,
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
  if (tool === 'describe_connector') {
    const kind = connector.kind;
    const schema = isGoogleKind(kind)
      ? connector.tools.map(name => ({ name, arguments: GOOGLE_TOOL_GUIDE[name] }))
      : await withConnector(connector, signal, async client =>
          (await client.list()).filter(t => connector.tools.includes(t.name)),
        );
    return workspaceResult(schema, wrap, 'connector schemas');
  }
  if (!connector.tools.includes(name)) throw new Error('This connector tool is not enabled.');
  if (typeof data.argumentsJson !== 'string' || data.argumentsJson.length > 64_000)
    throw new Error('Use a JSON object of at most 64,000 characters.');
  const args: unknown = JSON.parse(data.argumentsJson);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid tool arguments.');
  const input = args as Record<string, unknown>;
  const policy = await workspacePolicy();
  const memoryWrite = connector.kind === 'hindsight' && HINDSIGHT_ADD.has(name);
  const transfer =
    name === 'send_message' ||
    name === 'create_text_file' ||
    memoryWrite ||
    (connector.allowAdds && ADD_TOOL_NAME.test(name));
  if (
    memoryWrite &&
    (typeof input.content !== 'string' ||
      !input.content.trim() ||
      input.content.length > 20_000 ||
      Object.keys(input).some(key => !['content', 'context', 'timestamp', 'tags', 'metadata'].includes(key)))
  ) {
    throw new Error('Saving a memory requires new content and cannot target an existing document.');
  }
  if (
    (transfer &&
      (policy.actions === 'send' || policy.actions === 'chat' || (policy.actions === 'groups' && policy.transfers))) ||
    (policy.actions === 'groups' && policy.connectors)
  ) {
    const destination =
      name === 'send_message'
        ? String(input.to ?? '') + '\n' + String(input.subject ?? '')
        : String(input.name ?? input.title ?? (memoryWrite ? input.content : '') ?? '');
    if (
      !(await approve(
        'Usar conector',
        connector.name + ' · ' + name + (destination ? '\n' + destination.slice(0, 350) : ''),
        signal,
      ))
    ) {
      throw new Error('The user declined this connector call. Do not retry without new instructions.');
    }
  }
  const live = await workspace.connector(id);
  if (
    !live?.enabled ||
    !live.tools.includes(name) ||
    live.endpoint !== connector.endpoint ||
    live.token !== connector.token ||
    live.kind !== connector.kind ||
    live.local !== connector.local ||
    live.allowAdds !== connector.allowAdds
  ) {
    throw new Error('The user changed this connector.');
  }
  const credential = isGoogleKind(live.kind) ? await googleToken(live) : live.token;
  const result = isGoogleKind(live.kind)
    ? await googleCall({ ...live, token: credential }, name, input, signal)
    : await withConnector(live, signal, async client => {
        const tools = await client.list();
        if (!tools.some(t => t.name === name)) throw new Error('This tool is no longer approved for this connector.');
        return client.call(name, input);
      });
  const serialized = JSON.stringify(result) ?? 'null';
  const sanitized = credential ? serialized.replaceAll(credential, '[redacted]') : serialized;
  return workspaceResult(
    { tool: name, result: sanitized.slice(0, 5000) },
    wrap,
    'connector result',
    'Conector · ' + name,
  );
}
