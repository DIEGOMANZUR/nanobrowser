import type { AgentTool } from './tools';

const folderId = { type: 'string', description: 'Folder id returned by list_workspace_folders' };
const path = { type: 'string', description: 'Path relative to the authorized folder, using forward slashes' };

export const WORKSPACE_TOOLS: AgentTool[] = [
  {
    name: 'list_workspace_folders',
    source: 'agent',
    group: 'files',
    description:
      'List connected folders and, in Windows access mode, the available drives and known folders. Windows uses folderId "windows" and absolute drive paths.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'browse_workspace',
    source: 'agent',
    group: 'files',
    description:
      'List entries in an authorized folder by page, optionally filtering names. Results include file dates and sizes.',
    parameters: {
      type: 'object',
      properties: {
        folderId,
        path: { ...path, description: 'Relative subfolder path, or the absolute drive path when folderId is windows' },
        query: { type: 'string', description: 'Optional case-insensitive substring of an entry name' },
        offset: { type: 'integer', description: 'Next offset returned by the previous page for this directory' },
      },
      required: ['folderId'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_workspace_file',
    source: 'agent',
    group: 'files',
    description:
      'Read a portion of an authorized local text file when the user asks for its contents. File content will be sent to the configured model.',
    parameters: {
      type: 'object',
      properties: { folderId, path, offset: { type: 'integer', description: 'Character offset, default 0' } },
      required: ['folderId', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'save_workspace_file',
    source: 'agent',
    group: 'files',
    description:
      'Save new text in an authorized writable folder. Creates subfolders when needed and returns the actual path with a unique suffix. Ask only if the user has not requested a save.',
    parameters: {
      type: 'object',
      properties: {
        folderId,
        path: {
          ...path,
          description: 'Requested relative filename or subfolder/filename, ending in .txt, .md, .csv, .json or .html',
        },
        content: { type: 'string' },
      },
      required: ['folderId', 'path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'copy_workspace_file',
    source: 'agent',
    group: 'files',
    description:
      'Copy a local file into another authorized folder, including a downloaded PDF or Office file, preserving its extension and leaving the source in place.',
    parameters: {
      type: 'object',
      properties: {
        sourceId: { type: 'string', description: 'uploadId returned by browse_workspace' },
        folderId,
        path,
      },
      required: ['sourceId', 'folderId', 'path'],
      additionalProperties: false,
    },
  },
];

export const CONNECTOR_TOOLS: AgentTool[] = [
  {
    name: 'list_connectors',
    source: 'agent',
    group: 'working',
    description: 'List connected services and tools enabled by the user.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'describe_connector',
    source: 'agent',
    group: 'working',
    description: 'Read the argument schemas for a connector returned by list_connectors.',
    parameters: {
      type: 'object',
      properties: {
        connectorId: { type: 'string' },
        tool: { type: 'string', description: 'One tool name when the catalogue is large' },
      },
      required: ['connectorId'],
      additionalProperties: false,
    },
  },
  {
    name: 'call_connector',
    source: 'agent',
    group: 'working',
    description:
      'Use a tool authorized for a user request. Send only the necessary arguments. Use list_connectors for names and describe_connector for schemas.',
    parameters: {
      type: 'object',
      properties: {
        connectorId: { type: 'string' },
        tool: { type: 'string' },
        argumentsJson: { type: 'string', description: 'Arguments as a serialized JSON object' },
      },
      required: ['connectorId', 'tool', 'argumentsJson'],
      additionalProperties: false,
    },
  },
];
