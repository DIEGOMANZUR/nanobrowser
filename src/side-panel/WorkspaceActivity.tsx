import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { branchFrom, getEntries, listConversations } from '@src/store/conversations';
import type { Conversation, Entry } from '@src/store/types';
import { DEFAULT_SETTINGS, settingsStorage } from '@src/store/settings';
import { useStorage } from '@src/ui/hooks';
import { applyTheme } from '@src/ui/theme';
import '@src/ui/index.css';
import type { ActionReceipt } from '@src/browser-control';

interface Step {
  id: string;
  at: string;
  name: string;
  state: 'pending' | 'done' | 'failed' | 'skipped' | 'unverified';
  summary?: string;
}

export function stepsFrom(entries: Entry[]): Step[] {
  const steps: Step[] = [];
  const pending = new Map<string, number>();
  for (const entry of entries) {
    if (entry.type === 'intent' && entry.tool !== 'done') {
      pending.set(entry.toolCallId, steps.length);
      steps.push({ id: entry.id, at: entry.at, name: entry.tool, state: 'pending' });
    }
    if (entry.type !== 'message' || entry.message.role !== 'tool') continue;
    for (const part of entry.message.parts) {
      if (part.type === 'tool-result' && part.toolName !== 'done') {
        const line = part.text.split('\n')[0];
        const receipt = (entry.result as { receipt?: ActionReceipt } | undefined)?.receipt;
        const upload = part.toolName === 'upload' && receipt?.dispatched;
        const selection = receipt?.postcondition?.status;
        const uploadSummary =
          selection === 'met'
            ? 'El navegador confirmó la selección o el estado solicitado.'
            : 'El navegador no pudo confirmar la selección o el estado solicitado.';
        const summary = upload
          ? [uploadSummary, receipt?.postcondition?.detail].filter(Boolean).join(' ').slice(0, 350)
          : line && !line.startsWith('<<<') && !line.startsWith('The text between')
            ? line.slice(0, 350)
            : undefined;
        const index = pending.get(part.toolCallId) ?? steps.length;
        pending.delete(part.toolCallId);
        steps[index] = {
          id: steps[index]?.id ?? entry.id + '/' + index,
          at: entry.at,
          name: part.toolName,
          state: part.text.startsWith('skipped:')
            ? 'skipped'
            : part.isError
              ? 'failed'
              : upload && selection !== 'met'
                ? 'unverified'
                : 'done',
          summary,
        };
      }
    }
  }
  return steps.reverse();
}

const labels: Record<string, string> = {
  snapshot: 'Observar página',
  find: 'Buscar en página',
  read: 'Leer página',
  click: 'Pulsar control',
  set: 'Cambiar campo',
  type: 'Escribir',
  press: 'Pulsar tecla',
  navigate: 'Abrir página',
  fill_form: 'Rellenar formulario',
  upload: 'Adjuntar archivo',
  list_workspace_folders: 'Ver carpetas disponibles',
  browse_workspace: 'Explorar carpeta',
  read_workspace_file: 'Leer archivo',
  save_workspace_file: 'Crear archivo',
  save_file: 'Guardar en Descargas',
  copy_workspace_file: 'Copiar archivo',
  list_connectors: 'Ver conectores',
  call_connector: 'Usar conector',
  describe_connector: 'Consultar herramientas del conector',
  list_skills: 'Consultar habilidades',
  read_skill: 'Leer habilidad',
  desktop_windows: 'Enumerar ventanas de Windows',
  desktop_snapshot: 'Capturar ventana de Windows',
  desktop_act: 'Enviar entrada a Windows',
  propose_skill: 'Proponer habilidad',
  search_workspace: 'Buscar archivos en subcarpetas',
  archive_download: 'Archivar descarga del sitio',
  recall_notes: 'Consultar memoria local',
  remember_note: 'Guardar nota en Markdown',
};

const outcomes: Record<Step['state'], string> = {
  pending: 'Pendiente de resultado',
  done: 'Resultado registrado',
  failed: 'Con error o bloqueada',
  skipped: 'Omitida',
  unverified: 'Efecto sin confirmar',
};

function Activity() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selection, setSelection] = useState('');
  const [steps, setSteps] = useState<Step[]>([]);
  const [error, setError] = useState('');
  const [limit, setLimit] = useState(50);
  const popup = location.hash.startsWith('#popup');
  const sourceTab = Number(/[#&]tab=(\d+)/.exec(location.hash)?.[1]);
  const settings = useStorage(settingsStorage, DEFAULT_SETTINGS);
  useEffect(() => applyTheme(settings.theme), [settings.theme]);
  useEffect(() => {
    let live = true;
    let pending = false;
    let previous: string | undefined;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const chats = await listConversations();
        const chat = chats.find(c => c.id === selection) ?? chats.find(c => c.tabs.includes(sourceTab)) ?? chats[0];
        const version = JSON.stringify([
          chat?.id,
          chat?.leafId,
          chat?.updatedAt,
          chats.map(c => [c.id, c.title, c.status]),
        ]);
        if (version === previous) return;
        const rows = chat ? stepsFrom(branchFrom(await getEntries(chat.id), chat.leafId)) : [];
        if (live) {
          previous = version;
          setConversations(chats);
          setSteps(rows);
          setError('');
          if (selection !== (chat?.id ?? '')) setSelection(chat?.id ?? '');
        }
      } catch {
        if (live) setError('No se pudo leer el historial local.');
      } finally {
        pending = false;
      }
    };
    void refresh();
    const interval = setInterval(() => void refresh(), 1200);
    return () => {
      live = false;
      clearInterval(interval);
    };
  }, [selection, sourceTab]);
  return (
    <main className="nb-field min-h-screen px-4 py-5 text-nb-fg">
      <header className="mb-5 flex items-start justify-between gap-2">
        <h1 className="font-serif text-2xl">Historial de acciones</h1>
        {popup ? (
          <button type="button" className="shrink-0 text-sm underline" onClick={() => window.close()}>
            Cerrar
          </button>
        ) : (
          <a className="shrink-0 text-sm underline" href="sidepanel.html">
            Volver al chat
          </a>
        )}
      </header>
      {conversations.length ? (
        <label className="mb-4 block space-y-1 text-sm">
          <span>Tarea</span>
          <select
            className="w-full rounded-lg border border-nb-border bg-nb-surface p-2"
            value={selection}
            onChange={event => {
              setSelection(event.target.value);
              setLimit(50);
              setSteps([]);
            }}>
            {conversations.map(chat => (
              <option key={chat.id} value={chat.id}>
                {chat.title || 'Conversación'}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {error && <p role="alert">{error}</p>}
      {!steps.length && !error && (
        <p className="text-sm text-nb-fg/70">Las acciones aparecerán cuando el agente use una herramienta.</p>
      )}
      <ol className="space-y-2">
        {steps.slice(0, limit).map((step, index) => (
          <li key={step.id} className="rounded-lg border border-nb-border bg-nb-surface p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <strong className="text-sm">
                {steps.length - index}. {labels[step.name] ?? step.name}
              </strong>
              <time className="text-xs text-nb-fg/60" dateTime={step.at}>
                {new Date(step.at).toLocaleTimeString('es-CL')}
              </time>
            </div>
            <p className="mt-1 text-xs text-nb-fg/70">{outcomes[step.state]}</p>
            {step.summary && <p className="mt-2 break-words text-sm">{step.summary}</p>}
          </li>
        ))}
      </ol>
      {steps.length > limit && (
        <button
          type="button"
          className="mt-4 rounded-lg border border-nb-border px-3 py-2 text-sm"
          onClick={() => setLimit(limit + 50)}>
          Ver acciones anteriores
        </button>
      )}
    </main>
  );
}

createRoot(document.getElementById('app-container')!).render(<Activity />);
