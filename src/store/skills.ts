import { DESCRIPTION_MAX, NAME_MAX, parseSkillMd } from './shortcuts';
import type { WorkspaceSkill } from './workspace';

export const MAX_SKILL_FILE = 96 * 1024;
const MAX_SKILL_BUNDLE = 256 * 1024;
const REFERENCE = /^(?:references|assets)\/(?:[^/]+\/)*[^/]+\.(md|txt|csv|json|yaml|yml|xml)$/i;

function referencePath(path: string): boolean {
  return (
    path.length <= 240 &&
    REFERENCE.test(path) &&
    path
      .split('/')
      .every(part => !part.startsWith('.') && !/[\\:]/.test(part) && ![...part].some(char => char.charCodeAt(0) < 32))
  );
}

export function toWorkspaceSkill(source: string, references: WorkspaceSkill['references'] = []): WorkspaceSkill {
  const text = source.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n');
  if (new TextEncoder().encode(text).length > MAX_SKILL_FILE) throw new Error('SKILL.md supera los 96 KiB.');
  const parsed = parseSkillMd(text);
  const header = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text)?.[1] ?? '';
  const folded = /^description:\s*[>|][+-]?\s*\n((?: +[^\n]*\n?)+)/m.exec(header)?.[1];
  const description = (folded ?? parsed?.description ?? '').replace(/\s+/g, ' ').trim();
  if (
    !parsed ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(parsed.name) ||
    parsed.name.length > NAME_MAX ||
    !description ||
    description.length > DESCRIPTION_MAX ||
    !parsed.text.trim()
  ) {
    throw new Error('El archivo necesita un nombre de habilidad válido, una descripción y un cuerpo de instrucciones.');
  }
  const bytes = new TextEncoder();
  const names = references.map(ref => ref.path.toLowerCase());
  if (
    references.length > 16 ||
    new Set(names).size !== names.length ||
    references.some(ref => !referencePath(ref.path) || bytes.encode(ref.text).length > MAX_SKILL_FILE) ||
    bytes.encode(text).length + references.reduce((total, ref) => total + bytes.encode(ref.text).length, 0) >
      MAX_SKILL_BUNDLE
  ) {
    throw new Error('El paquete admite 16 referencias de texto y hasta 256 KiB en total.');
  }
  return {
    name: parsed.name,
    description,
    instructions: parsed.text,
    references,
    enabled: false,
    manual: /^disable-model-invocation:\s*(?:true|"true"|'true')\s*(?:#.*)?$/im.test(header),
  };
}

export async function readSkillFiles(files: File[]): Promise<{ skill: WorkspaceSkill; ignored: number }> {
  const paths = files.map(file => ({ file, path: file.webkitRelativePath.split('/').slice(1).join('/') || file.name }));
  const entry = paths.filter(item => item.path.toLowerCase() === 'skill.md');
  if (entry.length !== 1) throw new Error('Selecciona un archivo SKILL.md o una carpeta que lo contenga en su raíz.');
  const references = paths.filter(item => referencePath(item.path));
  const selected = [...entry, ...references];
  if (
    references.length > 16 ||
    selected.some(item => item.file.size > MAX_SKILL_FILE) ||
    selected.reduce((total, item) => total + item.file.size, 0) > MAX_SKILL_BUNDLE
  ) {
    throw new Error('El paquete supera el tamaño o el número de archivos admitido.');
  }
  const source = await entry[0].file.text();
  const contents = await Promise.all(references.map(async ({ path, file }) => ({ path, text: await file.text() })));
  return { skill: toWorkspaceSkill(source, contents), ignored: files.length - selected.length };
}

export function namedSkills(message: string): Set<string> {
  return new Set([...message.matchAll(/(?:^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=$|[\s,.!?:;])/g)].map(match => match[1]));
}
