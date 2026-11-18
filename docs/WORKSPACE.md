# Nanobrowser Workspace

## Abrir la extensión en Windows

El proyecto usa Node.js 24.22.1 o superior y la versión de pnpm fijada en `package.json`. Desde la raíz del repositorio se compila y registra el componente con estos comandos.

```powershell
pnpm install --frozen-lockfile
pnpm build
pwsh -NoProfile -File native/windows/install.ps1
```

1. En Chrome, abre `chrome://extensions`. En Edge, abre `edge://extensions`.
2. Activa **Modo desarrollador** y pulsa **Cargar extensión sin empaquetar**. Selecciona la carpeta `dist` creada por la compilación.
3. Abre Nanobrowser Workspace desde el botón **Extensiones**. Pulsa el engranaje **Ajustes** y elige **Carpetas y conectores** en la navegación lateral. En **Proveedores** se configura por separado el modelo que ejecutará las tareas.

## Archivos y permisos

- **Solo carpetas que elijas.** Selecciona **Solo lectura** o **Leer y crear archivos**, pulsa **Agregar carpeta** y confirma la carpeta en el explorador. **Reactivar** vuelve a solicitar el acceso cuando el navegador lo revoca. **Quitar acceso** olvida el permiso guardado por la extensión.
- **Pedir antes de acceder a una ruta de Windows.** Pulsa **Conectar componente de Windows**, concede el permiso del navegador y cambia **Alcance de búsqueda**. Aparece una tarjeta antes de abrir una carpeta o utilizar un archivo de una ruta de Windows.
- **Acceso completo.** Tras conectar el componente, marca **Habilitar opción de acceso completo** y selecciónala en **Alcance de búsqueda**. El componente trabaja como tu usuario de Windows, sin permisos de administrador, en unidades con letra. El selector de carpetas sigue disponible para unidades sincronizadas reconocidas por Chrome.
- **Permisos de acción.** El modo puede heredar el permiso del chat, ser automático, preguntar para transferencias o preguntar según grupos. Los grupos incluyen cambios detectados en sitios, envíos, creación de archivos y conectores. El modo de transferencias confirma también los envíos de formularios detectados. Los diálogos web de confirmación quedan a cargo del usuario y el navegador bloquea las operaciones que identifica como borrado. Los efectos de controles web se clasifican a partir de las señales de cada sitio.
- Los archivos de hasta 25 MiB se pueden copiar o adjuntar, incluidos documentos de Office y archivos PDF (formato de documento portátil). La lectura de contenido admite texto. La creación admite texto, hojas CSV (valores separados por comas), Markdown, JSON (notación de objetos de JavaScript) y HTML (lenguaje de marcado de hipertexto). Para copiar una descarga a otra carpeta, conecta también Descargas o usa el acceso de Windows. La descarga debe haber terminado.

## Conectores

En **Ajustes → Carpetas y conectores → Conectores**, selecciona el tipo, crea la conexión, pulsa **Ver herramientas compatibles**, marca las herramientas que deseas habilitar y pulsa **Guardar conector**.

- **Gmail**, **Google Calendar** y **Google Drive** usan un token de acceso de Google con los permisos correspondientes. Gmail permite buscar correos, ver cabeceras y enviar correo de texto. Calendar permite listar calendarios, consultar y crear eventos. Drive permite listar archivos, ver sus datos y crear archivos de texto. Si usas un token manual y vence, edita el conector y pega uno vigente.
- **Google Ads** permite seleccionar las operaciones de consulta del servidor oficial `google-ads-mcp`. Requiere que el servidor tenga acceso a tu cuenta publicitaria. Se puede usar como servidor local.
- **Hindsight** permite consultar recuerdos y guardar recuerdos nuevos si habilitas esas herramientas. Conecta un servidor instalado localmente o su dirección remota con el token del servicio, cuando corresponda.
- **MCP (Model Context Protocol)** genérico admite herramientas de consulta por el transporte seguro de hipertexto o por entrada y salida estándar en Windows. Usa servidores de confianza y credenciales que solo concedan lectura. El servidor controla los efectos reales de sus herramientas. Los conectores específicos validan las operaciones de creación que ofrecen.

Para un conector local, copia `native/windows/servers.example.json` a `%LOCALAPPDATA%\NanobrowserWorkspace\NativeHost\servers.json` y configura el nombre, la ruta del ejecutable instalado, los argumentos y el directorio de trabajo. Los nombres de las variables de entorno dependen del servidor. Mantén los secretos en la copia local. Marca **Usar un servidor instalado en Windows** e introduce el nombre de la entrada.

Para habilitar el inicio de sesión de Google en Chrome, crea un cliente OAuth 2.0 (protocolo de autorización) de tipo extensión de Chrome para el identificador `nfndkliilhpjpfldeenildglgddpmdfi` y habilita las interfaces que vas a usar en tu proyecto de Google Cloud. Define `NANOBROWSER_GOOGLE_CLIENT_ID` al compilar. En esta variante puedes dejar el token manual vacío y Google solicitará los permisos seleccionados al guardar el conector.

## Sesiones largas y actividad

En **Permisos de acción**, activa **Sin límite fijo de pasos, con aviso cada 100**. La configuración se aplica a la próxima ejecución. Los avisos quedan en el chat. Para mostrarlos también en el escritorio, pulsa **Activar notificaciones de escritorio**. El botón **Detener** queda disponible en el chat.

- **Alt + Mayús + H** abre **Historial de acciones** como panel lateral en la pestaña actual.
- **Control + Mayús + 8** abre una ventana de actividad desde el escritorio mientras Chrome o Edge sigue ejecutándose. Si el atajo está ocupado, revísalo en la página de atajos de extensiones del navegador.
- Cada fila del historial representa una operación y muestra la hora y el resultado conocido. El panel permite cambiar de tarea y consultar acciones anteriores.
