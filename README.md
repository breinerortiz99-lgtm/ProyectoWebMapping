# LuzFlorencia

Visor web para consultar luminarias de Florencia, reportar daños y revisar rutas. Leaflet consume una API REST en Node.js que consulta PostgreSQL/PostGIS directamente y entrega las capas como GeoJSON. El visor no depende de GeoServer.

## Capas del proyecto

| Capa | Registros | Uso en el visor |
|---|---:|---|
| Alumbrado público | 9.969 | Búsqueda, agrupamiento, estado y reportes |
| Calles | 2.910 | Referencia y red para las rutas |
| Barrios | 180 | Contexto territorial |
| Manzanas | 2.495 | Contexto urbano |
| Imagen satelital | Teselas web | Mapa base opcional |

Las capas vectoriales están en EPSG:3115. La API consulta PostGIS, transforma las geometrías a EPSG:4326 y las serializa como GeoJSON. Barrios, calles y manzanas se consultan según la ventana visible del mapa. La imagen satelital es una base de teselas independiente de las capas del proyecto.

## Funciones

- Inicio, registro, acceso, recuperación de contraseña por correo SMTP y vistas separadas.
- Roles de usuario y administrador, sesiones seguras y auditoría.
- Buscador de luminarias con atributos y agrupamiento de puntos.
- Capas de barrios, calles, manzanas y luminarias obtenidas por la API REST desde PostGIS.
- Control individual de capas y grupo completo, leyenda y minimapa.
- Reportes ciudadanos y panel administrativo con resúmenes, actualización de estados y auditoría.
- Análisis de proximidad mediante buffer y resaltado de luminarias.
- Rutas calculadas en PostGIS/pgRouting desde una luminaria hasta la Alcaldía, ubicación autorizada o punto marcado.

## Puesta en marcha en Windows

1. Compruebe que PostgreSQL/PostGIS esté activo y que las tablas del proyecto estén cargadas en la base luzflorencia. GeoServer no se necesita.
2. En pgAdmin, ejecute sql/create_reports.sql y luego sql/create_accounts.sql si todavía no creó esas tablas.
3. En PowerShell, abra PFinal/backend e instale las dependencias:

   npm install
   Copy-Item .env.example .env

4. Edite backend/.env con los datos de conexión PostgreSQL. Para recuperar contraseñas por correo, configure SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASSWORD y SMTP_FROM. Sin estos valores, el sistema informa que el envío no está configurado y no muestra enlaces de restablecimiento en la terminal.
5. Inicie la aplicación con npm run dev y abra http://127.0.0.1:8000.
6. Cree una cuenta. Para habilitar el panel administrador, asigne ese rol desde pgAdmin usando sql/promote_admin_template.sql.

## Arquitectura

Leaflet → API REST Node.js → PostgreSQL/PostGIS

La API permite únicamente las capas configuradas explícitamente, convierte las coordenadas del sistema EPSG:3115 a EPSG:4326 y filtra por el área visible. Supercluster agrupa los puntos de luminarias. pgRouting calcula recorridos sobre la red calles_ruteo.

## ¿Dónde se agregan las capas?

La carpeta `Capas/` contiene los archivos fuente que se importan en PostgreSQL/PostGIS. El mapa no lee directamente esos archivos: consulta las tablas de la base de datos por medio de la API Node.js.

Para incorporar una capa nueva:

1. Importe su archivo a PostGIS como una tabla espacial y confirme que tenga geometría válida y el SRID esperado (en este proyecto, EPSG:3115).
2. En `backend/server.js`, agréguela al objeto `spatialLayers`. La clave (por ejemplo, `parques`) será el nombre de la URL; `table` debe ser el nombre real de la tabla y `limit` limita el tamaño máximo de la respuesta.
3. En `frontend/js/visor.js` y, si debe aparecer también para administración, en `frontend/js/admin.js`, cree su capa Leaflet `L.geoJSON` vacía y defina su estilo. Los colores, grosores, rellenos y ventanas emergentes se configuran en esos archivos del navegador; PostGIS entrega atributos y geometrías, no estilos de GeoServer.
4. Añada la capa a la lista de capas vectoriales (`vectorLayerEntries` o `adminVectorEntries`) con el mismo nombre de `spatialLayers`, y agréguela al control de capas. Si también debe pertenecer a “Grupo completo de capas”, inclúyala en ese grupo.
5. Al activar la capa o mover el mapa, el visor pide `GET /api/layers/<nombre>?bbox=...`. El servidor filtra por el rectángulo visible, transforma la geometría de EPSG:3115 a EPSG:4326 y responde como GeoJSON. Leaflet incorpora las entidades a la capa conservando el estilo que se definió en el paso 3.

Ejemplo: si la tabla de PostGIS se llama `parques`, se registra `parques: { table: "parques", limit: 10000 }` en `spatialLayers`. En el visor se crea, por ejemplo, `const parkLayer = L.geoJSON(null, { style: ... })`, y luego se incluye `{ name: "parques", layer: parkLayer }` tanto en la lista que carga datos como en el control de capas. El nombre debe coincidir en los tres lugares: registro de API, lista de carga y control visual.

## Endpoints de la API REST

Todas las rutas usan el prefijo `/api`. Las rutas de registro, acceso, recuperación y salud son públicas; las demás exigen una sesión. Las rutas `/api/admin/...` exigen además rol `administrador`. La descripción junto a cada ruta está también en `backend/server.js`.

| Método y ruta | Para qué sirve |
|---|---|
| `GET /api/health` | Comprueba que la API y PostgreSQL estén respondiendo. |
| `POST /api/auth/register` | Crea una cuenta con rol `usuario` y abre su sesión. |
| `POST /api/auth/login` | Valida las credenciales, registra el acceso y crea la sesión. |
| `POST /api/auth/forgot-password` | Genera un enlace temporal de recuperación y lo envía por correo. |
| `POST /api/auth/reset-password` | Cambia la contraseña con un token de recuperación válido y revoca sesiones previas. |
| `GET /api/auth/me?page=...` | Devuelve los datos de la cuenta activa y registra la vista visitada. |
| `POST /api/auth/logout` | Invalida la sesión y elimina la cookie del navegador. |
| `GET /api/lamps/search?code=...` | Busca una luminaria por código y devuelve sus atributos y coordenadas. |
| `GET /api/layers/:name?bbox=...` | Devuelve una capa autorizada como GeoJSON; opcionalmente limita la consulta al área visible. |
| `GET /api/summary` | Cuenta las luminarias por estado para el resumen del visor de usuario. |
| `POST /api/reports` | Registra el daño reportado sobre una luminaria. |
| `POST /api/proximity` | Busca luminarias dentro del radio solicitado desde una ubicación. |
| `POST /api/route` | Calcula una ruta vial entre una luminaria y un destino. |
| `GET /api/admin/summary` | Devuelve los totales de usuarios y reportes para las tarjetas administrativas. |
| `GET /api/admin/reports` | Devuelve reportes con atributos y coordenadas para la tabla y el mapa del administrador. |
| `PATCH /api/admin/reports/:id/status` | Cambia el estado de un reporte y registra el cambio en auditoría. |
| `GET /api/admin/audit?limit=...` | Consulta los eventos de auditoría recientes, con un límite de filas. |

En las solicitudes `POST`, los datos se envían en JSON. En las respuestas espaciales, GeoJSON se usa porque representa geometrías y atributos de forma que Leaflet puede leer sin un servidor de mapas intermedio.

## Estructura

- frontend/pages/: inicio, acceso, registro, recuperación, visor y administración.
- frontend/css/ y frontend/js/: estilos y comportamiento de cada vista.
- backend/server.js: API REST, autenticación, reportes, consultas espaciales, SMTP y rutas.
- sql/: scripts de importación, preparación de red, cuentas y reportes.
- Capas/: datos vectoriales fuente.
