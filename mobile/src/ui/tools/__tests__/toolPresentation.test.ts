import { describe, expect, it } from 'vitest';
import { compactToolDetail, toolDisplayName } from '@/ui/tools/toolPresentation';

describe('tool presentation', () => {
  it('uses the shared explainable labels for internal tool names', () => {
    expect([
      'rg',
      'glob',
      'view',
      'apply_patch',
      'powershell',
      'skill',
      'task',
      'read_agent',
      'write_agent',
      'web_fetch',
      'web_search',
      'ask_user',
    ].map((name) => toolDisplayName(name))).toEqual([
      'Search',
      'Find Files',
      'View',
      'Edit Files',
      'Run Command',
      'Activate Skill',
      'Start Agent',
      'Read Agent',
      'Message Agent',
      'Fetch Web Page',
      'Search Web',
      'Ask User',
    ]);
  });

  it('title-cases understandable names and keeps compact details private', () => {
    expect(toolDisplayName('create_report')).toBe('Create Report');
    expect(compactToolDetail('view', { path: 'C:\\private\\repo\\App.tsx' })).toBe('App.tsx');
    expect(compactToolDetail('rg', { pattern: 'private search text' })).toBeNull();
    expect(compactToolDetail('powershell', { command: 'secret command' })).toBeNull();
    expect(compactToolDetail('view', { description: 'Read C:\\private\\repo\\App.tsx' })).toBe('Read App.tsx');
  });
});
