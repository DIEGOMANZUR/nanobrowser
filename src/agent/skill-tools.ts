import type { AgentTool } from './tools';

export const SKILL_TOOLS: AgentTool[] = [
  {
    name: 'list_skills',
    source: 'agent',
    group: 'working',
    description: 'List workflows the user enabled in Settings, including workflows explicitly invoked for this run.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_skill',
    source: 'agent',
    group: 'working',
    description:
      'Read an enabled skill matched to the user task, or read a text reference included when that skill was imported.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        path: { type: 'string', description: 'An imported reference path. Omit to read the skill instructions.' },
        offset: { type: 'integer', minimum: 0, description: 'Next character offset for long content' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
];
