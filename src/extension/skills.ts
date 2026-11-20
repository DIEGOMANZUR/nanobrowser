import type { ContentSource } from '@src/browser-control';
import { workspace } from '@src/store/workspace';
import { toWorkspaceSkill } from '@src/store/skills';

export async function runSkillTool(
  tool: string,
  args: Record<string, unknown>,
  explicit: ReadonlySet<string>,
  wrap: (text: string, source: ContentSource) => string,
) {
  if (tool === 'propose_skill') {
    const { name, description, instructions } = args;
    if (
      typeof name !== 'string' ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
      typeof description !== 'string' ||
      !description.trim() ||
      description.length > 1024 ||
      typeof instructions !== 'string' ||
      instructions.length > 12000
    )
      throw new Error('Provide a valid skill name, a short description and bounded instructions.');
    const skill = toWorkspaceSkill(
      ['---', 'name: ' + name, 'description: ' + JSON.stringify(description), '---', instructions].join('\n'),
    );
    await workspace.addSkill({ ...skill, generated: true });
    return {
      text: 'Borrador de habilidad guardado. Disponible en Ajustes → Habilidades para revisión y activación.',
      isError: false,
    };
  }
  const allowed = (await workspace.skills()).filter(
    skill => skill.enabled && (!skill.manual || explicit.has(skill.name)),
  );
  if (tool === 'list_skills') {
    const descriptions = allowed.map(skill => ({ name: skill.name, description: skill.description.slice(0, 256) }));
    const text = JSON.stringify(descriptions);
    return { text: wrap(text, { attachment: 'enabled skill catalogue' }), isError: false };
  }
  const skill = allowed.find(item => item.name === args.name);
  if (!skill) throw new Error('That skill is disabled, unavailable, or requires explicit invocation in the chat.');
  const ref = typeof args.path === 'string' ? skill.references.find(item => item.path === args.path) : undefined;
  if (args.path !== undefined && !ref) throw new Error('Choose a reference from this skill’s imported files.');
  const content = ref?.text ?? skill.instructions;
  const offset = typeof args.offset === 'number' && Number.isSafeInteger(args.offset) ? Math.max(0, args.offset) : 0;
  const end = Math.min(offset + 3800, content.length);
  const contentType = ref ? 'reference' : 'instructions';
  const meta = JSON.stringify({
    name: skill.name,
    contentType,
    ...(ref ? { path: ref.path } : { references: skill.references.map(item => item.path) }),
    ...(end < content.length && { nextOffset: end }),
  });
  return {
    text:
      'Workspace skill ' +
      contentType +
      '\n' +
      wrap(meta + '\n' + content.slice(offset, end), { attachment: 'skill ' + skill.name }),
    isError: false,
  };
}
