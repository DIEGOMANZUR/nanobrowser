import { useState } from 'react';
import { workspace, workspacePolicy } from '@src/store/workspace';
import { nativeRequest } from '@src/store/native-workspace';
import { googleCall, googleToken, isGoogleKind } from '@src/store/google-workspace';
import { withConnector } from '@src/store/mcp';
import type { Connector } from '@src/store/workspace';

async function probe(service: Connector, signal: AbortSignal) {
  if (isGoogleKind(service.kind)) {
    const read = service.tools.find(tool =>
      ['list_messages', 'list_files', 'list_calendars', 'list_events'].includes(tool),
    );
    if (!read) return 'Configurado · sin consulta habilitada para probar';
    const token = await googleToken(service);
    await googleCall({ ...service, token }, read, {}, signal);
    return 'Respondió a la consulta';
  }
  const count = await withConnector(
    service,
    signal,
    async client => (await client.list()).filter(tool => service.tools.includes(tool.name)).length,
  );
  return count ? count + ' herramientas disponibles' : 'Respondió · selección sin coincidencias';
}

export function WorkspaceOverview() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [services, setServices] = useState<Array<Pick<Connector, 'id' | 'name'>>>([]);
  const [facts, setFacts] = useState<string[]>([]);
  const [observed, setObserved] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState('');
  const openSettings = (section: string) =>
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html#' + section) });
  const refresh = async () => {
    setBusy(true);
    setFailure('');
    setObserved({});
    try {
      const [policy, skills, connectors, permission] = await Promise.all([
        workspacePolicy(),
        workspace.skills(),
        workspace.connectors(),
        chrome.permissions.contains({ permissions: ['nativeMessaging'] }),
      ]);
      const native =
        permission &&
        (await nativeRequest({ op: 'hello' }).then(
          () => true,
          () => false,
        ));
      setFacts([
        native ? 'Windows conectado' : 'Windows pendiente de conexión',
        'Archivos · ' +
          { full: 'acceso completo', ask: 'preguntar por ruta', folders: 'carpetas elegidas' }[policy.access],
        'Memoria · ' + (policy.memory ? 'activada' : 'desactivada'),
        'Habilidades · ' +
          skills.filter(skill => skill.enabled).length +
          ' activas, ' +
          skills.filter(skill => skill.generated && !skill.enabled).length +
          ' propuestas',
      ]);
      setServices(connectors.filter(service => service.enabled).map(({ id, name }) => ({ id, name })));
    } catch {
      setFailure('No se pudo leer el estado del espacio.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="relative">
      <button
        type="button"
        className="rounded-lg px-2 py-1 text-sm font-medium hover:bg-nb-surface"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (!open) void refresh();
        }}>
        Mi espacio
      </button>
      {open && (
        <section
          aria-label="Mi espacio"
          className="absolute left-0 top-full z-30 mt-2 grid w-64 gap-3 rounded-xl border border-nb-border bg-nb-bg p-4 text-sm text-nb-fg shadow-lg">
          <div className="flex items-center justify-between">
            <strong>Mi espacio</strong>
            <button type="button" aria-label="Cerrar Mi espacio" onClick={() => setOpen(false)}>
              Cerrar
            </button>
          </div>
          <ul className="grid gap-1">
            {facts.map(fact => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
          {failure && <p role="alert">{failure}</p>}
          {!busy && !services.length && <p>Sin conectores habilitados.</p>}
          {services.map(service => (
            <div key={service.id} className="border-t border-nb-border pt-2">
              <strong className="break-words">{service.name}</strong>
              <p role="status">{observed[service.id] ?? 'Configurado · sin comprobar'}</p>
              <button
                type="button"
                className="underline"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const live = await workspace.connector(service.id);
                    if (!live?.enabled) throw new Error();
                    const state = await probe(live, AbortSignal.timeout(10000));
                    setObserved(old => ({
                      ...old,
                      [service.id]: state + ' · ' + new Date().toLocaleTimeString('es-CL'),
                    }));
                  } catch {
                    setObserved(old => ({ ...old, [service.id]: 'Sin verificar · revisa la conexión y sus permisos' }));
                  } finally {
                    setBusy(false);
                  }
                }}>
                Comprobar conexión
              </button>
            </div>
          ))}
          <div className="flex flex-wrap gap-3">
            <button type="button" className="underline" onClick={() => void openSettings('workspace')}>
              Carpetas y conectores
            </button>
            <button type="button" className="underline" onClick={() => void openSettings('skills')}>
              Habilidades
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
