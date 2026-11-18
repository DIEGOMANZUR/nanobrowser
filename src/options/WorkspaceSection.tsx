import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { DEFAULT_WORKSPACE_POLICY, updateWorkspacePolicy, workspace, workspacePolicy } from '@src/store/workspace';
import type { Connector, FolderMode, WorkspaceDirectory, WorkspaceFolder, WorkspacePolicy } from '@src/store/workspace';
import { nativeRequest } from '@src/store/native-workspace';
import { connectorEndpoint, withConnector } from '@src/store/mcp';
import { GOOGLE_TOOLS, googleToken, isGoogleKind } from '@src/store/google-workspace';
import { SettingsCard } from './SettingsCard';

const field = 'w-full rounded-md border border-nb-border bg-nb-field px-3 py-2 text-sm';
const button =
  'rounded-md border border-nb-border bg-nb-surface px-3 py-2 text-sm hover:bg-nb-field disabled:opacity-50';
const blank: Connector = { id: '', name: '', endpoint: '', token: '', tools: [], enabled: false, kind: 'mcp' };

export function WorkspaceSection() {
  const [policy, setPolicy] = useState(DEFAULT_WORKSPACE_POLICY);
  const [folders, setFolders] = useState<WorkspaceFolder[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [mode, setMode] = useState<FolderMode>('read');
  const [draft, setDraft] = useState<Connector>(blank);
  const [discovered, setDiscovered] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [windowsReady, setWindowsReady] = useState(false);
  const [allowFull, setAllowFull] = useState(false);
  const kind = draft.kind ?? 'mcp';
  const google = isGoogleKind(kind);
  const googleSignIn = google && !!chrome.runtime.getManifest().oauth2?.client_id && !!chrome.identity?.getAuthToken;

  useEffect(() => {
    void Promise.all([workspacePolicy(), workspace.folders(), workspace.connectors()])
      .then(([settings, directories, services]) => {
        setPolicy(settings);
        setAllowFull(settings.access === 'full');
        setFolders(directories);
        setConnectors(services);
      })
      .catch(error => setStatus(String(error)));
    void chrome.permissions.contains({ permissions: ['nativeMessaging'] }).then(granted => {
      if (granted)
        void nativeRequest({ op: 'hello' })
          .then(() => setWindowsReady(true))
          .catch(() => undefined);
    });
  }, []);

  const perform = async (work: () => Promise<void>) => {
    setBusy(true);
    setStatus('');
    try {
      await work();
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'AbortError') setStatus(String(error));
    } finally {
      setBusy(false);
    }
  };
  const change = async (update: Partial<WorkspacePolicy>) => {
    const settings = { ...policy, ...update };
    await updateWorkspacePolicy(settings);
    setPolicy(settings);
  };
  const chooseFolder = () =>
    perform(async () => {
      const picker = window as Window & {
        showDirectoryPicker?: (options: { mode: FolderMode; id: string }) => Promise<WorkspaceDirectory>;
      };
      if (!picker.showDirectoryPicker) throw new Error('Abre esta página en Chrome o Edge de escritorio.');
      const handle = await picker.showDirectoryPicker({ mode, id: 'nanobrowser-workspace' });
      const linked = await workspace.folders();
      let previous: WorkspaceFolder | undefined;
      for (const item of linked)
        if (await handle.isSameEntry(item.handle)) {
          previous = item;
          break;
        }
      await workspace.putFolder({ id: previous?.id ?? crypto.randomUUID(), name: handle.name, mode, handle });
      setFolders(await workspace.folders());
      setStatus('Carpeta conectada.');
    });
  const testWindows = () =>
    perform(async () => {
      if (!(await chrome.permissions.request({ permissions: ['nativeMessaging'] })))
        throw new Error('Permiso de Windows rechazado.');
      await nativeRequest({ op: 'hello' });
      setWindowsReady(true);
      setStatus('Componente de Windows conectado.');
    });
  const editConnector = (connector: Connector) => {
    setDraft(connector);
    setDiscovered(connector.tools);
  };
  const discover = () =>
    perform(async () => {
      const next = isGoogleKind(kind)
        ? [...GOOGLE_TOOLS[kind]]
        : await withConnector(
            { ...draft, endpoint: draft.endpoint.trim(), token: draft.token.trim(), kind },
            new AbortController().signal,
            async client => (await client.list()).map(tool => tool.name),
          );
      setDiscovered(next);
      setStatus(
        next.length
          ? 'Selecciona las herramientas que podrá usar el agente.'
          : 'El servidor no anunció herramientas de solo lectura compatibles.',
      );
    });
  const saveConnector = (event: FormEvent) => {
    event.preventDefault();
    void perform(async () => {
      const endpoint = google ? '' : draft.local ? draft.endpoint.trim() : connectorEndpoint(draft.endpoint.trim());
      if (!draft.name.trim()) throw new Error('Escribe un nombre para el conector.');
      if (!draft.tools.length) throw new Error('Selecciona al menos una herramienta.');
      if (google && !draft.token.trim()) {
        if (!googleSignIn) throw new Error('Introduce el token de acceso de Google.');
        await googleToken(draft, true);
      }
      await workspace.putConnector({
        ...draft,
        id: draft.id || crypto.randomUUID(),
        endpoint,
        token: draft.token.trim(),
        name: draft.name.trim(),
        tools: draft.tools.filter(tool => discovered.includes(tool)),
        enabled: true,
      });
      setConnectors(await workspace.connectors());
      editConnector(blank);
      setStatus('Conector guardado.');
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <SettingsCard title="Acceso a archivos" className="flex flex-col gap-4">
        <label className="space-y-1 text-sm">
          <span>Alcance de búsqueda</span>
          <select
            className={field}
            value={policy.access}
            disabled={busy}
            onChange={e => {
              const next = e.target.value as WorkspacePolicy['access'];
              void perform(() => change({ access: next }));
            }}>
            <option value="folders">Solo carpetas que elijas</option>
            <option value="ask" disabled={!windowsReady}>
              Pedir antes de acceder a una ruta de Windows
            </option>
            <option value="full" disabled={!windowsReady || !allowFull}>
              Acceso completo con mi cuenta de Windows
            </option>
          </select>
        </label>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <button type="button" className={button} disabled={busy} onClick={() => void testWindows()}>
            Conectar componente de Windows
          </button>
          {windowsReady && (
            <label>
              <input type="checkbox" checked={allowFull} onChange={e => setAllowFull(e.target.checked)} /> Habilitar
              opción de acceso completo
            </label>
          )}
        </div>
        <p className="text-sm text-nb-fg/70">
          El acceso completo incluye archivos privados que tu cuenta pueda abrir. El contenido leído puede llegar al
          proveedor del modelo. Puedes cambiar el alcance en cualquier momento.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1 text-sm">
            <span>Permiso para la nueva carpeta</span>
            <select className={field} value={mode} onChange={e => setMode(e.target.value as FolderMode)}>
              <option value="read">Solo lectura</option>
              <option value="readwrite">Leer y crear archivos</option>
            </select>
          </label>
          <button type="button" className={button} onClick={() => void chooseFolder()} disabled={busy}>
            Agregar carpeta
          </button>
        </div>
        <ul className="divide-y divide-nb-border">
          {folders.map(folder => (
            <li key={folder.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <span className="mr-auto break-all">
                {folder.name} · {folder.mode === 'read' ? 'Lectura' : 'Lectura y creación'}
              </span>
              <button
                type="button"
                className={button}
                onClick={() =>
                  void perform(async () => {
                    const allowed = await folder.handle.requestPermission({ mode: folder.mode });
                    setStatus(allowed === 'granted' ? 'Carpeta reactivada.' : 'Permiso sin conceder.');
                  })
                }>
                Reactivar
              </button>
              <button
                type="button"
                className={button}
                onClick={() =>
                  void perform(async () => {
                    await workspace.forgetFolder(folder.id);
                    setFolders(await workspace.folders());
                    setStatus('Acceso quitado.');
                  })
                }>
                Quitar acceso
              </button>
            </li>
          ))}
        </ul>
      </SettingsCard>

      <SettingsCard title="Permisos de acción" className="flex flex-col gap-4">
        <label className="space-y-1 text-sm">
          <span>Cuándo pedir aprobación</span>
          <select
            className={field}
            value={policy.actions}
            onChange={e => void perform(() => change({ actions: e.target.value as WorkspacePolicy['actions'] }))}>
            <option value="auto">Automático</option>
            <option value="chat">Según el modo del chat</option>
            <option value="send">Antes de enviar correos o archivos</option>
            <option value="groups">Por grupo de acciones</option>
          </select>
        </label>
        {policy.actions === 'groups' && (
          <fieldset className="grid gap-2 text-sm">
            <legend>Grupos que requieren aprobación</legend>
            {(
              [
                ['browser', 'Cambios detectados en sitios'],
                ['transfers', 'Envío de correos y archivos'],
                ['files', 'Creación de archivos'],
                ['connectors', 'Uso de conectores'],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={policy[key]}
                  onChange={e => void perform(() => change({ [key]: e.target.checked }))}
                />{' '}
                {label}
              </label>
            ))}
          </fieldset>
        )}
        <label className="text-sm">
          <input
            type="checkbox"
            checked={policy.unlimited}
            onChange={e => void perform(() => change({ unlimited: e.target.checked }))}
          />{' '}
          Sin límite fijo de pasos, con aviso cada 100
        </label>
        <button
          type="button"
          className={button}
          onClick={() =>
            void perform(async () => {
              const granted = await chrome.permissions.request({ permissions: ['notifications'] });
              setStatus(granted ? 'Notificaciones de escritorio activadas.' : 'Los avisos se mostrarán en el chat.');
            })
          }>
          Activar notificaciones de escritorio
        </button>
        <p className="text-sm text-nb-fg/70">
          Alt + Mayús + H abre el historial en el navegador. Control + Mayús + 8 abre una ventana de actividad mientras
          el navegador esté en ejecución.
        </p>
      </SettingsCard>

      <SettingsCard title="Conectores" className="flex flex-col gap-4">
        <ul className="divide-y divide-nb-border">
          {connectors.map(service => (
            <li key={service.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <span className="mr-auto break-all">
                {service.name} · {service.enabled ? 'Activo' : 'Desactivado'}
              </span>
              <button type="button" className={button} onClick={() => editConnector(service)}>
                Editar
              </button>
              <button
                type="button"
                className={button}
                onClick={() =>
                  void perform(async () => {
                    await workspace.putConnector({ ...service, enabled: !service.enabled });
                    setConnectors(await workspace.connectors());
                  })
                }>
                {service.enabled ? 'Pausar' : 'Activar'}
              </button>
            </li>
          ))}
        </ul>
        <form className="grid gap-3 text-sm" onSubmit={saveConnector}>
          <label className="space-y-1">
            <span>Tipo</span>
            <select
              className={field}
              value={draft.kind ?? 'mcp'}
              onChange={e => editConnector({ ...blank, kind: e.target.value as Connector['kind'] })}>
              <option value="mcp">MCP (Model Context Protocol)</option>
              <option value="googleAds">Google Ads</option>
              <option value="hindsight">Hindsight</option>
              <option value="gmail">Gmail</option>
              <option value="calendar">Google Calendar</option>
              <option value="drive">Google Drive</option>
            </select>
          </label>
          <label className="space-y-1">
            <span>Nombre</span>
            <input
              className={field}
              required
              maxLength={80}
              value={draft.name}
              onChange={e => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          {!google && (
            <>
              <label>
                <input
                  type="checkbox"
                  disabled={!windowsReady}
                  checked={!!draft.local}
                  onChange={e => {
                    setDraft({ ...draft, endpoint: '', token: '', tools: [], local: e.target.checked });
                    setDiscovered([]);
                  }}
                />{' '}
                Usar un servidor instalado en Windows
              </label>
              <label className="space-y-1">
                <span>
                  {draft.local
                    ? 'Nombre en servers.json'
                    : 'Dirección HTTPS (protocolo seguro de transferencia de hipertexto)'}
                </span>
                <input
                  className={field}
                  type={draft.local ? 'text' : 'url'}
                  required
                  value={draft.endpoint}
                  onChange={e => {
                    setDraft({ ...draft, endpoint: e.target.value, tools: [] });
                    setDiscovered([]);
                  }}
                  placeholder={draft.local ? 'servidor-local' : 'https://servidor.example/mcp'}
                />
              </label>
            </>
          )}
          {!draft.local && (
            <label className="space-y-1">
              <span>{googleSignIn ? 'Token manual (opcional)' : 'Token de acceso'}</span>
              <input
                className={field}
                type="password"
                autoComplete="off"
                value={draft.token}
                onChange={e => setDraft({ ...draft, token: e.target.value })}
              />
            </label>
          )}
          {kind === 'mcp' && (
            <label>
              <input
                type="checkbox"
                checked={!!draft.allowAdds}
                onChange={e => {
                  setDraft({ ...draft, tools: [], allowAdds: e.target.checked });
                  setDiscovered([]);
                }}
              />{' '}
              Incluir operaciones de creación declaradas como no destructivas por este servidor
            </label>
          )}
          <button type="button" className={button} disabled={busy} onClick={() => void discover()}>
            Ver herramientas compatibles
          </button>
          {!!discovered.length && (
            <fieldset className="grid gap-2">
              <legend>Herramientas autorizadas</legend>
              {discovered.map(name => (
                <label key={name} className="break-all">
                  <input
                    type="checkbox"
                    checked={draft.tools.includes(name)}
                    onChange={e =>
                      setDraft({
                        ...draft,
                        tools: e.target.checked ? [...draft.tools, name] : draft.tools.filter(tool => tool !== name),
                      })
                    }
                  />{' '}
                  {name}
                </label>
              ))}
            </fieldset>
          )}
          <button type="submit" className={button} disabled={busy || !draft.tools.length}>
            Guardar conector
          </button>
        </form>
      </SettingsCard>
      {status && (
        <p role="status" className="sticky bottom-2 rounded-md border border-nb-border bg-nb-surface p-3 text-sm">
          {status}
        </p>
      )}
    </div>
  );
}
