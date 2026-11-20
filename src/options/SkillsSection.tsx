import { useEffect, useRef, useState } from 'react';
import { readSkillFiles } from '@src/store/skills';
import { workspace } from '@src/store/workspace';
import type { WorkspaceSkill } from '@src/store/workspace';
import { Button } from '@src/ui/components';
import { SettingsCard } from './SettingsCard';

export function SkillsSection() {
  const [skills, setSkills] = useState<WorkspaceSkill[]>([]);
  const [preview, setPreview] = useState<WorkspaceSkill>();
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    void workspace
      .skills()
      .then(setSkills)
      .catch(() => setStatus('No se pudo leer la biblioteca.'));
  }, []);

  async function perform(task: () => Promise<void>) {
    setBusy(true);
    try {
      await task();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'No se pudo completar la operación.');
    } finally {
      setBusy(false);
    }
  }

  async function select(files: File[]) {
    if (!files.length) return;
    setPreview(undefined);
    const { skill, ignored } = await readSkillFiles(files);
    setPreview(skill);
    setStatus(ignored ? 'Archivos fuera de los formatos admitidos: ' + ignored + '.' : '');
  }

  return (
    <SettingsCard title="Biblioteca de habilidades" className="flex flex-col gap-4">
      <p className="text-sm">
        Importa instrucciones reutilizables para tus tareas. Revisa el contenido antes de habilitar una habilidad.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => file.current?.click()}>
          Importar SKILL.md
        </Button>
        <Button disabled={busy} onClick={() => folder.current?.click()}>
          Importar carpeta
        </Button>
        <input
          type="file"
          ref={file}
          hidden
          accept=".md"
          onChange={event => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = '';
            void perform(() => select(files));
          }}
        />
        <input
          type="file"
          ref={element => {
            folder.current = element;
            element?.setAttribute('webkitdirectory', '');
          }}
          hidden
          multiple
          onChange={event => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = '';
            void perform(() => select(files));
          }}
        />
      </div>
      {preview && (
        <section aria-label="Vista previa de la habilidad" className="space-y-2 rounded-lg border border-nb-border p-3">
          <h3 className="font-semibold">{preview.name}</h3>
          <p className="break-words text-sm">{preview.description}</p>
          <textarea
            readOnly
            aria-label="Instrucciones importadas"
            rows={8}
            value={preview.instructions}
            className="w-full rounded border border-nb-border bg-nb-bg p-2 font-mono text-sm"
          />
          {preview.references.length > 0 && (
            <p className="break-words text-sm">Referencias: {preview.references.map(ref => ref.path).join(', ')}</p>
          )}
          <Button
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                if (await workspace.skill(preview.name))
                  throw new Error(
                    'Ya existe una habilidad con ese nombre. Cambia el campo name dentro de SKILL.md para importar otra versión.',
                  );
                await workspace.addSkill(preview);
                setSkills(await workspace.skills());
                setPreview(undefined);
                setStatus('Habilidad importada. Puedes habilitarla en la lista.');
              })
            }>
            Guardar habilidad
          </Button>
        </section>
      )}
      <ul className="divide-y divide-nb-border">
        {skills.map(skill => (
          <li key={skill.name} className="grid gap-1 py-3">
            <label className="font-medium">
              <input
                type="checkbox"
                disabled={busy}
                checked={skill.enabled}
                onChange={event => {
                  const enabled = event.target.checked;
                  void perform(async () => {
                    await workspace.setSkillEnabled(skill.name, enabled);
                    setSkills(await workspace.skills());
                  });
                }}
              />{' '}
              {skill.name}
            </label>
            <span className="break-words text-sm text-nb-fg/75">{skill.description}</span>
            {skill.generated && (
              <span className="text-sm">
                Propuesta del agente{skill.enabled ? ' · habilitada' : ' · pendiente de activación'}
              </span>
            )}
            {skill.manual && (
              <span className="text-sm">
                Escribe <code>/{skill.name}</code> en el mensaje para activarla.
              </span>
            )}
            <details className="text-sm">
              <summary>Ver instrucciones</summary>
              <a
                download="SKILL.md"
                className="underline"
                href={
                  'data:text/markdown;charset=utf-8,' +
                  encodeURIComponent(
                    [
                      '---',
                      'name: ' + skill.name,
                      'description: ' + JSON.stringify(skill.description),
                      ...(skill.manual ? ['disable-model-invocation: true'] : []),
                      '---',
                      skill.instructions,
                    ].join('\n'),
                  )
                }>
                Exportar instrucciones como SKILL.md
              </a>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">{skill.instructions}</pre>
            </details>
          </li>
        ))}
      </ul>
      {status && (
        <p role="status" className="text-sm">
          {status}
        </p>
      )}
    </SettingsCard>
  );
}
