import type { AgentTool } from './tools';

export const DESKTOP_KEYS = [
  'Tab',
  'Enter',
  'Escape',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  'ArrowLeft',
  'ArrowUp',
  'ArrowRight',
  'ArrowDown',
] as const;

export const DESKTOP_TOOLS: AgentTool[] = [
  {
    name: 'desktop_windows',
    source: 'agent',
    group: 'working',
    description: 'List eligible Windows application windows. Only use for the application the user requested.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'desktop_snapshot',
    source: 'agent',
    group: 'working',
    description:
      'Observe the approved Windows application. The image uses pixel coordinates starting at the top left. Capture again after every desktop input.',
    parameters: {
      type: 'object',
      properties: { windowId: { type: 'string', description: 'Window id from desktop_windows' } },
      required: ['windowId'],
      additionalProperties: false,
    },
  },
  {
    name: 'desktop_act',
    source: 'agent',
    group: 'working',
    description:
      'With the user’s confirmation, click, scroll, insert text or press a navigation key in the latest capture of the approved Windows application. Returns whether Windows dispatched the input. Observe again to verify its effect.',
    parameters: {
      type: 'object',
      properties: {
        snapshotId: { type: 'string' },
        action: { type: 'string', enum: ['click', 'scroll', 'type', 'key'] },
        target: { type: 'string', description: 'Visible control and intended effect, as described to the user' },
        x: { type: 'integer', minimum: 0 },
        y: { type: 'integer', minimum: 0 },
        scroll: { type: 'integer', minimum: -6, maximum: 6, description: 'Wheel steps. Positive up, negative down.' },
        text: {
          type: 'string',
          description: 'Plain text to insert into the focused field. No secrets, line breaks, or commands.',
        },
        key: { type: 'string', enum: [...DESKTOP_KEYS] },
      },
      required: ['snapshotId', 'action', 'target'],
      additionalProperties: false,
    },
  },
];
