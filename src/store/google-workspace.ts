import type { Connector } from './workspace';
import { encodeBase64 } from './base64';

export const GOOGLE_TOOLS = {
  gmail: ['list_messages', 'get_message', 'send_message'],
  calendar: ['list_calendars', 'list_events', 'create_event'],
  drive: ['list_files', 'get_file_metadata', 'create_text_file'],
} as const;

export type GoogleKind = keyof typeof GOOGLE_TOOLS;

export const GOOGLE_TOOL_GUIDE: Record<string, string> = {
  list_messages: '{q?: string, pageToken?: string}',
  get_message: '{id: string}',
  send_message: '{to: string, subject: string, body: string}',
  list_calendars: '{pageToken?: string}',
  list_events: '{calendar?: string, q?: string, timeMin?: string, timeMax?: string, pageToken?: string}',
  create_event:
    '{calendar?: string, title: string, start: ISO date-time with time zone, end: ISO date-time with time zone, description?: string}',
  list_files: '{q?: string, pageToken?: string}',
  get_file_metadata: '{id: string}',
  create_text_file: '{name: string, text: string, parentId?: string}',
};

export function isGoogleKind(kind: Connector['kind']): kind is GoogleKind {
  return kind === 'gmail' || kind === 'calendar' || kind === 'drive';
}

const SCOPES: Record<string, string> = {
  list_messages: 'gmail.readonly',
  get_message: 'gmail.readonly',
  send_message: 'gmail.send',
  list_calendars: 'calendar.calendarlist.readonly',
  list_events: 'calendar.events.readonly',
  create_event: 'calendar.events',
  list_files: 'drive.metadata.readonly',
  get_file_metadata: 'drive.metadata.readonly',
  create_text_file: 'drive.file',
};

export async function googleToken(connector: Connector, interactive = false): Promise<string> {
  if (connector.token) return connector.token;
  const kind = connector.kind;
  if (!isGoogleKind(kind) || !chrome.runtime.getManifest().oauth2?.client_id || !chrome.identity?.getAuthToken) {
    throw new Error('Provide a Google access token or configure Google sign-in for this build.');
  }
  const scopes = [
    ...new Set(
      connector.tools
        .filter(tool => (GOOGLE_TOOLS[kind] as readonly string[]).includes(tool))
        .map(tool => 'https://www.googleapis.com/auth/' + SCOPES[tool]),
    ),
  ];
  if (!scopes.length) throw new Error('Select at least one Google tool first.');
  const result = await chrome.identity.getAuthToken({ interactive, scopes, enableGranularPermissions: true });
  if (!result.token || (result.grantedScopes && scopes.some(scope => !result.grantedScopes?.includes(scope)))) {
    throw new Error('Authorize the selected scopes in Settings.');
  }
  return result.token;
}

function str(args: Record<string, unknown>, key: string, limit = 500, required = true): string {
  const value = args[key];
  if (!required && value === undefined) return '';
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > limit) {
    throw new Error('Invalid or missing connector argument: ' + key);
  }
  return value;
}

const fileFields = 'id,name,mimeType,modifiedTime,size,webViewLink,parents';

export async function googleCall(
  connector: Connector,
  tool: string,
  args: Record<string, unknown>,
  userSignal: AbortSignal,
) {
  const kind = connector.kind;
  if (
    !isGoogleKind(kind) ||
    !(GOOGLE_TOOLS[kind] as readonly string[]).includes(tool) ||
    !connector.tools.includes(tool)
  ) {
    throw new Error('This Google tool is unavailable.');
  }
  const token = connector.token;
  if (!token || !/^[!-~]+$/.test(token)) throw new Error('Add a Google access token in Settings.');
  const headers = new Headers({ Authorization: 'Bearer ' + token });
  let path = '';
  let body: string | undefined;
  const query = new URLSearchParams();
  const pageToken = str(args, 'pageToken', 1000, false);
  if (pageToken) query.set('pageToken', pageToken);
  const q = str(args, 'q', 500, false);
  if (q) query.set('q', q);
  const id = () => encodeURIComponent(str(args, 'id'));
  const calendar = () => encodeURIComponent(str(args, 'calendar', 500, false) || 'primary');
  switch (tool) {
    case 'list_messages':
      path = '/gmail/v1/users/me/messages';
      query.set('maxResults', '20');
      break;
    case 'get_message':
      path = '/gmail/v1/users/me/messages/' + id();
      query.set('format', 'metadata');
      query.set('fields', 'id,threadId,snippet,payload(headers)');
      for (const header of ['From', 'To', 'Subject', 'Date']) query.append('metadataHeaders', header);
      break;
    case 'send_message': {
      path = '/gmail/v1/users/me/messages/send';
      const to = str(args, 'to', 254);
      const subject = str(args, 'subject', 160);
      if (!/^[^\s@<>;,\r\n]+@[^\s@<>;,\r\n]+\.[^\s@<>;,\r\n]+$/.test(to) || /[\r\n]/.test(subject)) {
        throw new Error('Use a single recipient and a one-line subject.');
      }
      const encode = (text: string) => encodeBase64(new TextEncoder().encode(text));
      const encodedSubject = encode(subject);
      const content = encode(str(args, 'body', 20_000))
        .match(/.{1,76}/g)
        ?.join('\r\n');
      const message = [
        'To: ' + to,
        'Subject: =?UTF-8?B?' + encodedSubject + '?=',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        content,
      ].join('\r\n');
      body = JSON.stringify({
        raw: encode(message).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''),
      });
      break;
    }
    case 'list_calendars':
      path = '/calendar/v3/users/me/calendarList';
      query.set('maxResults', '20');
      break;
    case 'list_events':
      path = '/calendar/v3/calendars/' + calendar() + '/events';
      query.set('maxResults', '15');
      query.set('singleEvents', 'true');
      query.set('orderBy', 'startTime');
      for (const key of ['timeMin', 'timeMax']) {
        const value = str(args, key, 50, false);
        if (value) query.set(key, value);
      }
      break;
    case 'create_event': {
      path = '/calendar/v3/calendars/' + calendar() + '/events';
      const start = str(args, 'start', 50);
      const end = str(args, 'end', 50);
      if (
        !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(start) ||
        !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(end) ||
        !(Date.parse(start) < Date.parse(end))
      ) {
        throw new Error('Use start and end times with explicit time zones, and an end after the start.');
      }
      body = JSON.stringify({
        summary: str(args, 'title', 250),
        start: { dateTime: start },
        end: { dateTime: end },
        description: str(args, 'description', 5000, false),
      });
      break;
    }
    case 'list_files':
      path = '/drive/v3/files';
      query.set('pageSize', '20');
      query.set('fields', 'nextPageToken,files(' + fileFields + ')');
      query.set('q', q ? '(' + q + ') and trashed = false' : 'trashed = false');
      break;
    case 'get_file_metadata':
      path = '/drive/v3/files/' + id();
      query.set('fields', fileFields);
      break;
    case 'create_text_file': {
      path = '/upload/drive/v3/files';
      const name = str(args, 'name', 160);
      if (!/\.(txt|md|csv|json)$/i.test(name) || /[/\\\r\n]/.test(name)) throw new Error('Use a text file name.');
      const boundary = 'nb-' + crypto.randomUUID();
      const parentId = str(args, 'parentId', 500, false);
      headers.set('Content-Type', 'multipart/related; boundary=' + boundary);
      body = [
        '--' + boundary,
        'Content-Type: application/json; charset=UTF-8',
        '',
        JSON.stringify({ name, ...(parentId && { parents: [parentId] }) }),
        '--' + boundary,
        'Content-Type: text/plain; charset=UTF-8',
        '',
        str(args, 'text', 50_000, false),
        '--' + boundary + '--',
        '',
      ].join('\r\n');
      query.set('uploadType', 'multipart');
      query.set('fields', fileFields);
      break;
    }
  }
  if (body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const host =
    kind === 'gmail' ? 'gmail.googleapis.com' : kind === 'calendar' ? 'www.googleapis.com' : 'www.googleapis.com';
  const response = await fetch('https://' + host + path + (query.size ? '?' + query : ''), {
    headers,
    method: body ? 'POST' : 'GET',
    body,
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.any([userSignal, AbortSignal.timeout(20_000)]),
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error('Google returned status ' + response.status + '. Check the token and its scopes.');
  }
  return response.json();
}
