import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { toWorkspaceSkill, namedSkills, readSkillFiles } from '@src/store/skills';
import { workspace } from '@src/store/workspace';
import { runSkillTool } from '../skills';
import { desktopInput } from '../desktop';

describe('Workspace skill imports', () => {
  it('parses multiline descriptions and starts disabled', () => {
    const skill = toWorkspaceSkill(
      '---\nname: clean-notes\ndescription: >-\n  Prepare notes for review\n  before filing.\ndisable-model-invocation: true\n---\nGroup notes by subject.\n',
    );
    expect(skill).toMatchObject({
      name: 'clean-notes',
      description: 'Prepare notes for review before filing.',
      manual: true,
      enabled: false,
    });
    expect([...namedSkills('Trabaja con /clean-notes, por favor.')]).toEqual(['clean-notes']);
    expect(namedSkills('https://example.test/clean-notes').size).toBe(0);
  });

  it('imports text references while leaving scripts out, then requires enablement and explicit invocation', async () => {
    const file = (path: string, text: string) =>
      Object.defineProperty(new File([text], path.split('/').at(-1)!), 'webkitRelativePath', {
        value: 'fixture/' + path,
      });
    const { skill, ignored } = await readSkillFiles([
      file(
        'SKILL.md',
        '---\nname: archive-notes\ndescription: Organize notes.\ndisable-model-invocation: true\n---\nUse the approved workflow.',
      ),
      file('references/checklist.md', 'Reference sample.'),
      file('scripts/run.ps1', 'Ignored fixture script.'),
    ]);
    expect(ignored).toBe(1);
    expect(skill.references.map(ref => ref.path)).toEqual(['references/checklist.md']);
    await workspace.addSkill(skill);
    const wrap = (text: string) => text;
    const tools = (name: string, args: Record<string, unknown>, explicit: string[] = []) =>
      runSkillTool(name, args, new Set(explicit), wrap);
    expect((await tools('list_skills', {}, [skill.name])).text).toBe('[]');
    await workspace.setSkillEnabled(skill.name, true);
    expect((await tools('list_skills', {})).text).toBe('[]');
    expect((await tools('read_skill', { name: skill.name }, [skill.name])).text).toContain(
      'Use the approved workflow.',
    );
    expect(
      (await tools('read_skill', { name: skill.name, path: 'references/checklist.md' }, [skill.name])).text,
    ).toContain('Reference sample.');
    await expect(tools('read_skill', { name: skill.name, path: 'scripts/run.ps1' }, [skill.name])).rejects.toThrow(
      /imported/,
    );
    await workspace.setSkillEnabled(skill.name, false);
    await expect(tools('read_skill', { name: skill.name }, [skill.name])).rejects.toThrow(/disabled/);
    await expect(workspace.addSkill(skill)).rejects.toMatchObject({ name: 'ConstraintError' });
  });
});

describe('Desktop input validation', () => {
  it('binds coordinates to the screenshot and accepts literal text and navigation keys', () => {
    const bounds = { width: 540, height: 320 };
    expect(desktopInput({ action: 'click', target: 'Agregar nota', x: 23, y: 40 }, bounds)).toMatchObject({
      x: 23,
      y: 40,
    });
    expect(desktopInput({ action: 'scroll', target: 'Ver notas', x: 23, y: 40, scroll: -2 }, bounds).scroll).toBe(-2);
    expect(desktopInput({ action: 'type', target: 'Nueva nota', text: 'Árbol' }, bounds).text).toBe('Árbol');
    expect(desktopInput({ action: 'key', target: 'Cambiar de campo', key: 'Tab' }, bounds).key).toBe('Tab');
    expect(() => desktopInput({ action: 'click', target: 'Eliminar nota', x: 23, y: 40 }, bounds)).toThrow();
    expect(() => desktopInput({ action: 'click', target: 'Agregar nota', x: 540, y: 40 }, bounds)).toThrow();
    expect(() => desktopInput({ action: 'key', target: 'Nueva nota', key: 'Delete' }, bounds)).toThrow();
    expect(() => desktopInput({ action: 'type', target: 'Nueva nota', text: 'Hola\n' }, bounds)).toThrow();
  });
});
