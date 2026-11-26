"use strict";

const path = require("node:path");
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const express = require("express");
const nodemailer = require("nodemailer");
const { Pool } = require("pg");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const app = express();
const port = Number(process.env.PORT || 8000);
const frontendDir = path.resolve(__dirname, "..", "frontend");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
  max: 5,
});
const scrypt = promisify(crypto.scrypt);
const SESSION_HOURS = 12;
const SESSION_COOKIE = "lf_session";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireDatabase() {
  if (!process.env.DATABASE_URL) {
    throw new HttpError(503, "Falta configurar DATABASE_URL en backend/.env.");
  }
}

function requiredText(value, field, maxLength) {
  const clean = typeof value === "string" ? value.trim() : "";
  if (!clean || clean.length > maxLength) {
    throw new HttpError(
      400,
      `El campo ${field} es obligatorio y admite hasta ${maxLength} caracteres.`,
    );
  }
  return clean;
}

function validPoint(point) {
  const lat = Number(point?.lat);
  const lon = Number(point?.lon);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  ) {
    throw new HttpError(400, "El destino debe tener coordenadas válidas.");
  }
  return { lat, lon };
}

// Normaliza los correos en un solo punto para comparar y guardar siempre el mismo valor.
function normalizeEmail(value) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, "Escribe un correo electrónico válido.");
  }
  return email;
}

function validatePassword(value) {
  if (typeof value !== "string" || value.length < 10 || value.length > 200) {
    throw new HttpError(
      400,
      "La contraseña debe tener entre 10 y 200 caracteres.",
    );
  }
  return value;
}

// Guarda contraseñas como hashes con sal aleatoria; nunca almacena la contraseña original.
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt}$${derived.toString("hex")}`;
}

async function verifyPassword(password, encoded) {
  const [algorithm, n, r, p, salt, expectedHex] = String(encoded || "").split(
    "$",
  );
  if (algorithm !== "scrypt" || !salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const actual = await scrypt(password, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return (
    expected.length === actual.length &&
    crypto.timingSafeEqual(expected, actual)
  );
}

function cookieValue(req, name) {
  const entry = (req.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  if (!entry) return "";
  try {
    return decodeURIComponent(entry.slice(name.length + 1));
  } catch {
    return "";
  }
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_HOURS * 60 * 60}${secure}`,
  );
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
  );
}

function tokenDigest(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Registra en auditoría quién hizo una acción, cuál fue, y metadatos mínimos de la petición.
async function writeAudit(req, user, action, details = {}) {
  await pool.query(
    `INSERT INTO public.auditoria_usuario
       (usuario_id, correo, accion, detalles, direccion_ip, agente_usuario)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
    [
      user?.id || null,
      user?.email || null,
      action,
      JSON.stringify(details),
      req.ip || null,
      String(req.get("user-agent") || "").slice(0, 500),
    ],
  );
}

// Envía el enlace temporal por correo y evita exponer el token en la consola del servidor.
async function deliverResetLink(email, name, resetUrl) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
  });
  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to: email,
    subject: "Restablece tu contraseña de LuzFlorencia",
    text:
      "Hola " +
      name +
      ", usa este enlace antes de 30 minutos para cambiar tu contraseña: " +
      resetUrl,
    html:
      "<p>Hola " +
      String(name).replace(/[&<>"]/g, "") +
      ',</p><p>Usa este enlace antes de 30 minutos para cambiar tu contraseña:</p><p><a href="' +
      resetUrl +
      '">Restablecer contraseña</a></p><p>Si no solicitaste este cambio, ignora este mensaje.</p>',
  });
}

// Valida la cookie contra una sesión vigente en PostgreSQL antes de permitir una acción privada.
async function requireAuth(req, _res, next) {
  try {
    const token = cookieValue(req, SESSION_COOKIE);
    if (!token) throw new HttpError(401, "Inicia sesión para continuar.");
    const result = await pool.query(
      `SELECT u.id, u.nombre, u.correo, u.rol
       FROM public.sesiones_usuario s
       JOIN public.usuarios u ON u.id = s.usuario_id
       WHERE s.token_hash = $1 AND s.vence_en > now() AND u.activo = TRUE`,
      [tokenDigest(token)],
    );
    if (!result.rowCount)
      throw new HttpError(401, "Tu sesión venció. Inicia sesión otra vez.");
    req.user = {
      id: result.rows[0].id,
      name: result.rows[0].nombre,
      email: result.rows[0].correo,
      role: result.rows[0].rol,
    };
    next();
  } catch (error) {
    next(error);
  }
}

function requireRole(role) {
  return (req, _res, next) => {
    if (req.user?.role !== role)
      return next(
        new HttpError(403, "No tienes permisos para consultar esta sección."),
      );
    next();
  };
}

app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));

// GET /api/health: comprueba que el servidor tiene acceso a PostgreSQL.
app.get("/api/health", async (_req, res) => {
  requireDatabase();
  await pool.query("SELECT 1");
  res.json({ status: "ok" });
});

// POST /api/auth/register: crea una cuenta pública con rol usuario y abre su sesión.
// El rol se asigna en el servidor para impedir que alguien se registre como administrador.
app.post("/api/auth/register", async (req, res) => {
  requireDatabase();
  const name = requiredText(req.body?.name, "nombre", 120);
  const email = normalizeEmail(req.body?.email);
  const password = validatePassword(req.body?.password);
  const passwordHash = await hashPassword(password);
  let result;
  try {
    result = await pool.query(
      `INSERT INTO public.usuarios (nombre, correo, password_hash, rol)
       VALUES ($1, $2, $3, 'usuario')
       RETURNING id, nombre, correo, rol`,
      [name, email, passwordHash],
    );
  } catch (error) {
    if (error.code === "23505")
      throw new HttpError(409, "Ya existe una cuenta con ese correo.");
    throw error;
  }
  const user = {
    id: result.rows[0].id,
    name: result.rows[0].nombre,
    email: result.rows[0].correo,
    role: result.rows[0].rol,
  };
  const token = crypto.randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO public.sesiones_usuario (token_hash, usuario_id, vence_en)
     VALUES ($1, $2, now() + interval '${SESSION_HOURS} hours')`,
    [tokenDigest(token), user.id],
  );
  await writeAudit(req, user, "CUENTA_REGISTRADA");
  setSessionCookie(res, token);
  res.status(201).json({ user });
});

// POST /api/auth/login: verifica correo y contraseña, crea una sesión y registra el acceso.
// El mensaje de error es genérico para no revelar si un correo está registrado.
app.post("/api/auth/login", async (req, res) => {
  requireDatabase();
  const email = normalizeEmail(req.body?.email);
  const password = validatePassword(req.body?.password);
  const result = await pool.query(
    `SELECT id, nombre, correo, password_hash, rol, activo
     FROM public.usuarios WHERE correo = $1`,
    [email],
  );
  const row = result.rows[0];
  const passwordMatches = row
    ? await verifyPassword(password, row.password_hash)
    : false;
  if (!row || !passwordMatches || !row.activo) {
    await writeAudit(req, { email }, "INICIO_SESION_FALLIDO");
    throw new HttpError(401, "Correo o contraseña incorrectos.");
  }
  const user = {
    id: row.id,
    name: row.nombre,
    email: row.correo,
    role: row.rol,
  };
  const token = crypto.randomBytes(32).toString("base64url");
  await pool.query(
    "DELETE FROM public.sesiones_usuario WHERE vence_en <= now()",
  );
  await pool.query(
    `INSERT INTO public.sesiones_usuario (token_hash, usuario_id, vence_en)
     VALUES ($1, $2, now() + interval '${SESSION_HOURS} hours')`,
    [tokenDigest(token), user.id],
  );
  await writeAudit(req, user, "INICIO_SESION");
  setSessionCookie(res, token);
  res.json({ user });
});

// POST /api/auth/forgot-password: crea un token de un solo uso y manda su enlace por SMTP.
// Responde igual exista o no la cuenta, para no revelar qué correos están registrados.
app.post("/api/auth/forgot-password", async (req, res) => {
  requireDatabase();
  const smtpSettings = ["SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM"];
  if (smtpSettings.some((key) => !process.env[key]?.trim())) {
    throw new HttpError(
      503,
      "La recuperación por correo aún no está configurada. Contacta al administrador del sistema.",
    );
  }
  const email = normalizeEmail(req.body?.email);
  const result = await pool.query(
    "SELECT id, nombre, correo FROM public.usuarios WHERE correo = $1 AND activo = TRUE",
    [email],
  );
  if (result.rowCount) {
    const user = { id: result.rows[0].id, name: result.rows[0].nombre, email };
    const token = crypto.randomBytes(32).toString("base64url");
    await pool.query(
      "DELETE FROM public.restablecimiento_clave WHERE vence_en <= now() OR usado_en IS NOT NULL",
    );
    await pool.query(
      `INSERT INTO public.restablecimiento_clave (token_hash, usuario_id, vence_en)
       VALUES ($1, $2, now() + interval '30 minutes')`,
      [tokenDigest(token), user.id],
    );
    await writeAudit(req, user, "RECUPERACION_SOLICITADA");
    // Conserva el mismo host con el que el usuario abrió la app (localhost o 127.0.0.1).
    // APP_BASE_URL se usa cuando el sitio está publicado detrás de un dominio/proxy.
    const baseUrl = (process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
    const resetUrl = `${baseUrl}/pages/reset-password.html?token=${encodeURIComponent(token)}`;
    try {
      await deliverResetLink(email, user.name, resetUrl);
    } catch (error) {
      // Informa el fallo del proveedor SMTP sin afirmar que el correo sí fue enviado.
      console.error("No se pudo entregar el correo de recuperación.");
      throw new HttpError(
        503,
        "No fue posible enviar el correo de recuperación. Inténtalo más tarde.",
      );
    }
  }
  res.json({
    message:
      "Si existe una cuenta con ese correo, enviaremos un enlace válido durante 30 minutos.",
  });
});

// POST /api/auth/reset-password: valida el token recibido por correo, cambia la clave
// y cierra las sesiones existentes para proteger la cuenta.
app.post("/api/auth/reset-password", async (req, res) => {
  requireDatabase();
  const token = requiredText(req.body?.token, "token", 200);
  const password = validatePassword(req.body?.password);
  const passwordHash = await hashPassword(password);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT t.usuario_id, u.correo FROM public.restablecimiento_clave t
       JOIN public.usuarios u ON u.id = t.usuario_id
       WHERE t.token_hash = $1 AND t.vence_en > now() AND t.usado_en IS NULL
       FOR UPDATE OF t`,
      [tokenDigest(token)],
    );
    if (!result.rowCount)
      throw new HttpError(
        400,
        "El enlace venció o ya fue utilizado. Solicita uno nuevo.",
      );
    const account = result.rows[0];
    await client.query(
      "UPDATE public.usuarios SET password_hash = $1 WHERE id = $2",
      [passwordHash, account.usuario_id],
    );
    await client.query(
      "UPDATE public.restablecimiento_clave SET usado_en = now() WHERE token_hash = $1",
      [tokenDigest(token)],
    );
    await client.query(
      "DELETE FROM public.sesiones_usuario WHERE usuario_id = $1",
      [account.usuario_id],
    );
    await client.query(
      `INSERT INTO public.auditoria_usuario (usuario_id, correo, accion)
       VALUES ($1, $2, 'CLAVE_RESTABLECIDA')`,
      [account.usuario_id, account.correo],
    );
    await client.query("COMMIT");
    res.json({
      message: "La contraseña se actualizó. Ya puedes iniciar sesión.",
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

// A partir de aquí, todas las rutas /api requieren una sesión válida.
// Las rutas de salud y autenticación están declaradas arriba y permanecen públicas.
app.use("/api", (req, _res, next) => {
  return requireAuth(req, _res, next);
});

app.get("/api/auth/me", async (req, res) => {
  // GET /api/auth/me: devuelve la cuenta actual para mostrar nombre y validar su rol.
  // El parámetro page deja constancia en auditoría de la vista que acaba de abrir.
  const page = ["visor", "administrador"].includes(req.query.page)
    ? req.query.page
    : "sesion";
  await writeAudit(req, req.user, "ACCESO_VISTA", { page });
  res.json({ user: req.user });
});

app.post("/api/auth/logout", async (req, res) => {
  // POST /api/auth/logout: invalida la sesión guardada y borra la cookie del navegador.
  const token = cookieValue(req, SESSION_COOKIE);
  if (token) {
    await writeAudit(req, req.user, "CIERRE_SESION");
    await pool.query(
      "DELETE FROM public.sesiones_usuario WHERE token_hash = $1",
      [tokenDigest(token)],
    );
  }
  clearSessionCookie(res);
  res.status(204).end();
});

// Registro de capas que la API permite consultar. La clave es el nombre usado en la URL;
// table debe coincidir con la tabla PostGIS y limit protege el servidor ante respuestas enormes.
// Para publicar una capa nueva: agregarla aquí y también configurarla en cada visor Leaflet.
const spatialLayers = {
  barrios: { table: "barrios", limit: 25000 },
  calles: { table: "calles", limit: 25000 },
  manzanas: { table: "manzanas", limit: 25000 },
  alumbrado: { table: "alumbrado", limit: 50000 },
};

// Convierte el bbox de Leaflet (longitud/latitud) en números y rechaza rangos inválidos.
function parseLayerBbox(value) {
  if (value === undefined) return null;
  const bbox = String(value).split(",").map(Number);
  if (bbox.length !== 4 || !bbox.every(Number.isFinite)) throw new HttpError(400, "El área del mapa no es válida.");
  const [west, south, east, north] = bbox;
  if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) throw new HttpError(400, "El área del mapa está fuera de los límites permitidos.");
  return bbox;
}

// GET /api/lamps/search?code=...: busca una luminaria por su código y devuelve atributos
// y coordenadas EPSG:4326 para centrar el mapa, abrir la ficha o calcular una ruta.
app.get("/api/lamps/search", async (req, res) => {
  requireDatabase();
  const code = requiredText(req.query.code, "code", 120);
  const result = await pool.query(
    "SELECT to_jsonb(a) - 'geom' - 'fotografia' AS properties, " +
      "ST_X(ST_Transform(a.geom, 4326)) AS lon, ST_Y(ST_Transform(a.geom, 4326)) AS lat " +
      "FROM public.alumbrado a WHERE a.cod_ilumin::text = $1 LIMIT 1", [code]);
  if (!result.rowCount) throw new HttpError(404, "No encontramos una luminaria con ese código.");
  const row = result.rows[0];
  await writeAudit(req, req.user, "BUSQUEDA_LUMINARIA", { code });
  res.json({ properties: row.properties, coordinates: [row.lon, row.lat] });
});

// GET /api/layers/:name?bbox=oeste,sur,este,norte: entrega una capa PostGIS como GeoJSON.
// El visor llama esta ruta cuando una capa está activa y cambia el área visible del mapa.
// bbox llega en EPSG:4326; se transforma a EPSG:3115 para filtrar con la geometría almacenada.
// Finalmente se transforma la geometría a EPSG:4326 porque Leaflet espera coordenadas web.
// ST_AsGeoJSON construye el formato estándar sin GeoServer. La tabla se toma solo de la lista
// permitida de arriba para evitar que el nombre enviado por la URL se use como SQL arbitrario.
app.get("/api/layers/:name", async (req, res) => {
  requireDatabase();
  const name = String(req.params.name || "").toLowerCase();
  const definition = spatialLayers[name];
  if (!definition) throw new HttpError(404, "La capa solicitada no existe.");
  const bbox = parseLayerBbox(req.query.bbox);
  const where = bbox ? "WHERE t.geom && ST_Transform(ST_MakeEnvelope($1, $2, $3, $4, 4326), 3115)" : "";
  const sql = [
    "SELECT COALESCE(jsonb_agg(jsonb_build_object(",
    "'type', 'Feature', 'id', layer_row.gid,",
    "'geometry', ST_AsGeoJSON(ST_Transform(layer_row.geom, 4326), 6)::jsonb,",
    "'properties', to_jsonb(layer_row) - 'geom' - 'fotografia'",
    ") ORDER BY layer_row.gid), '[]'::jsonb) AS features",
    "FROM (SELECT t.* FROM public." + definition.table + " t", where,
    "ORDER BY t.gid LIMIT " + definition.limit + ") AS layer_row"
  ].filter(Boolean).join(" ");
  const result = await pool.query(sql, bbox || []);
  res.set("Cache-Control", "private, max-age=60");
  res.json({ type: "FeatureCollection", features: result.rows[0]?.features || [] });
});


// GET /api/summary: agrupa luminarias por estado para las tarjetas del visor de usuario.
app.get("/api/summary", async (_req, res) => {
  requireDatabase();
  const result = await pool.query(`
    SELECT COALESCE(NULLIF(BTRIM(est_ilumin::text), ''), 'SIN DATO') AS estado,
           count(*)::integer AS total
    FROM public.alumbrado
    GROUP BY 1 ORDER BY total DESC
  `);
  res.json(result.rows);
});



// POST /api/reports: guarda el daño reportado y lo vincula a la luminaria y al usuario.
app.post("/api/reports", async (req, res) => {
  requireDatabase();
  const code = requiredText(req.body?.code, "code", 120);
  const type = requiredText(req.body?.type, "type", 80);
  const description = requiredText(req.body?.description, "description", 1000);
  const contact =
    typeof req.body?.contact === "string"
      ? req.body.contact.trim().slice(0, 120)
      : "";

  const lamp = await pool.query(
    "SELECT gid FROM public.alumbrado WHERE cod_ilumin::text = $1 LIMIT 1",
    [code],
  );
  if (lamp.rowCount === 0)
    throw new HttpError(
      404,
      "La luminaria indicada ya no aparece en la base de datos.",
    );

  const result = await pool.query(
    `
    INSERT INTO public.reportes_alumbrado
      (alumbrado_gid, cod_ilumin, tipo_dano, descripcion, contacto, estado_reporte, usuario_id)
    VALUES ($1, $2, $3, $4, NULLIF($5, ''), 'RECIBIDO', $6)
    RETURNING id, fecha_reporte
  `,
    [lamp.rows[0].gid, code, type, description, contact, req.user.id],
  );
  await writeAudit(req, req.user, "REPORTE_CREADO", {
    report_id: result.rows[0].id,
    code,
    damage_type: type,
  });

  res.status(201).json({
    id: result.rows[0].id,
    created_at: result.rows[0].fecha_reporte.toISOString(),
  });
});

app.post("/api/proximity", async (req, res) => {
  // POST /api/proximity: consulta luminarias dentro de un radio alrededor del punto enviado.
  // Recibe ubicación EPSG:4326, la convierte a EPSG:3115 y devuelve distancias en metros,
  // resumen por estado y puntos GeoJSON para resaltarlos en el mapa.
  requireDatabase();
  const center = validPoint(req.body?.center);
  const radius = Number(req.body?.radius_m ?? 100);
  if (!Number.isInteger(radius) || radius < 25 || radius > 1000) {
    throw new HttpError(
      400,
      "El radio debe ser un número entero entre 25 y 1000 metros.",
    );
  }

  const result = await pool.query(
    `WITH origin AS (
       SELECT ST_Transform(ST_SetSRID(ST_MakePoint($1, $2), 4326), 3115) AS geom
     )
     SELECT a.cod_ilumin, COALESCE(NULLIF(BTRIM(a.est_ilumin::text), ''), 'SIN DATO') AS estado,
            ROUND(ST_Distance(a.geom, o.geom)::numeric, 1)::float AS distancia_m,
            ST_X(ST_Transform(a.geom, 4326)) AS lon,
            ST_Y(ST_Transform(a.geom, 4326)) AS lat
     FROM public.alumbrado a CROSS JOIN origin o
     WHERE ST_DWithin(a.geom, o.geom, $3)
     ORDER BY a.geom <-> o.geom`,
    [center.lon, center.lat, radius],
  );
  const byStatus = result.rows.reduce((summary, row) => {
    summary[row.estado] = (summary[row.estado] || 0) + 1;
    return summary;
  }, {});
  const features = result.rows.map((row) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [row.lon, row.lat] },
    properties: {
      code: row.cod_ilumin,
      status: row.estado,
      distance_m: row.distancia_m,
    },
  }));
  await writeAudit(req, req.user, "ANALISIS_PROXIMIDAD", {
    radius_m: radius,
    lamps_found: features.length,
  });
  res.json({
    radius_m: radius,
    nearby_count: features.length,
    by_status: byStatus,
    features,
  });
});

app.post("/api/route", async (req, res) => {
  // POST /api/route: calcula con pgRouting el camino vial entre una luminaria y un destino.
  // Devuelve la línea como GeoJSON y su longitud; el navegador la dibuja y encuadra.
  requireDatabase();
  const code = requiredText(req.body?.code, "code", 120);
  const destination = validPoint(req.body?.destination);

  const result = await pool.query(
    `
    WITH lamp AS (
      SELECT geom FROM public.alumbrado WHERE cod_ilumin::text = $1 LIMIT 1
    ), destination AS (
      SELECT ST_Transform(ST_SetSRID(ST_MakePoint($2, $3), 4326), 3115) AS geom
    ), start_snap AS (
      -- Ajusta la luminaria a la geometría vial más cercana, no a un nodo distante.
      SELECT l.geom AS real_geom, e.id AS edge_id,
             ST_ClosestPoint(e.geom, l.geom) AS snap_geom
      FROM lamp l
      CROSS JOIN LATERAL (
        SELECT id, geom FROM public.calles_ruteo
        ORDER BY geom <-> l.geom LIMIT 1
      ) e
    ), end_snap AS (
      -- Ajusta el destino al tramo vial más cercano.
      SELECT d.geom AS real_geom, e.id AS edge_id,
             ST_ClosestPoint(e.geom, d.geom) AS snap_geom
      FROM destination d
      CROSS JOIN LATERAL (
        SELECT id, geom FROM public.calles_ruteo
        ORDER BY geom <-> d.geom LIMIT 1
      ) e
    ), start_vertex AS (
      -- El grafo inicia en nodos; selecciona el extremo cercano del tramo ajustado.
      SELECT v.id, v.geom, s.real_geom, s.snap_geom
      FROM start_snap s
      JOIN public.calles_ruteo e ON e.id = s.edge_id
      JOIN public.calles_ruteo_vertices_pgr v
        ON v.id = CASE
          WHEN ST_Distance(s.snap_geom, ST_StartPoint(e.geom)) < ST_Distance(s.snap_geom, ST_EndPoint(e.geom)) THEN e.source
          ELSE e.target
        END
    ), end_vertex AS (
      SELECT v.id, v.geom, d.real_geom, d.snap_geom
      FROM end_snap d
      JOIN public.calles_ruteo e ON e.id = d.edge_id
      JOIN public.calles_ruteo_vertices_pgr v
        ON v.id = CASE
          WHEN ST_Distance(d.snap_geom, ST_StartPoint(e.geom)) < ST_Distance(d.snap_geom, ST_EndPoint(e.geom)) THEN e.source
          ELSE e.target
        END
    ), path AS (
      SELECT d.seq, d.node, d.edge, e.geom, e.source, d.cost
      FROM start_vertex s, end_vertex t,
           LATERAL pgr_dijkstra(
             'SELECT id, source, target, cost, reverse_cost FROM public.calles_ruteo',
             s.id, t.id, directed := false
           ) d
      LEFT JOIN public.calles_ruteo e ON e.id = d.edge
      WHERE d.edge <> -1
    ), route_parts AS (
      -- Conecta cada punto real al nodo vial usando el punto ajustado sobre la calle.
      SELECT 0 AS orden, ST_MakeLine(ARRAY[s.real_geom, s.snap_geom, s.geom]) AS geom,
             ST_Length(ST_MakeLine(ARRAY[s.real_geom, s.snap_geom, s.geom])) AS distance_m
      FROM start_vertex s
      UNION ALL
      SELECT p.seq, CASE WHEN p.node = p.source THEN p.geom ELSE ST_Reverse(p.geom) END,
             p.cost
      FROM path p
      UNION ALL
      SELECT 2147483647 AS orden, ST_MakeLine(ARRAY[t.geom, t.snap_geom, t.real_geom]),
             ST_Length(ST_MakeLine(ARRAY[t.geom, t.snap_geom, t.real_geom]))
      FROM end_vertex t
    ), route_result AS (
      SELECT ST_LineMerge(ST_Collect(geom ORDER BY orden)) AS geom,
             SUM(distance_m) AS distance_m
      FROM route_parts
    )
    SELECT ST_AsGeoJSON(ST_Transform(r.geom, 4326)) AS geometry,
           r.distance_m,
           EXISTS(SELECT 1 FROM lamp) AS lamp_found
    FROM route_result r
  `,
    [code, destination.lon, destination.lat],
  );

  const row = result.rows[0];
  if (!row?.lamp_found)
    throw new HttpError(404, "No encontramos esa luminaria.");
  if (!row.geometry)
    throw new HttpError(
      422,
      "No se encontró un recorrido conectado entre ambos puntos de la red vial.",
    );
  await writeAudit(req, req.user, "RUTA_CALCULADA", { code });
  res.json({
    geometry: JSON.parse(row.geometry),
    distance_m: Number(row.distance_m || 0),
  });
});

// GET /api/admin/summary: solo administradores; alimenta tarjetas de reportes y usuarios.
app.get(
  "/api/admin/summary",
  requireRole("administrador"),
  async (req, res) => {
    const result = await pool.query(`
    SELECT
      (SELECT count(*)::integer FROM public.reportes_alumbrado) AS total_reports,
      (SELECT count(*)::integer FROM public.usuarios WHERE activo = TRUE) AS total_users,
      (SELECT count(*)::integer FROM public.reportes_alumbrado WHERE UPPER(BTRIM(estado_reporte)) = 'RECIBIDO') AS received_reports,
      (SELECT count(*)::integer FROM public.reportes_alumbrado WHERE UPPER(BTRIM(estado_reporte)) = 'EN_REVISION') AS in_review_reports,
      (SELECT count(*)::integer FROM public.reportes_alumbrado WHERE UPPER(BTRIM(estado_reporte)) = 'RESUELTO') AS resolved_reports,
      (SELECT count(*)::integer FROM public.usuarios WHERE creado_en >= date_trunc('day', now())) AS users_today
  `);
    await writeAudit(req, req.user, "CONSULTA_RESUMEN_ADMIN");
    res.json(result.rows[0]);
  },
);

// GET /api/admin/reports: solo administradores; entrega reportes, sus estados y coordenadas
// tomadas de las luminarias vinculadas para llenar la tabla y el mapa administrativo.
app.get(
  "/api/admin/reports",
  requireRole("administrador"),
  async (req, res) => {
    const result = await pool.query(`
    SELECT r.id, r.cod_ilumin AS code, r.tipo_dano AS damage_type,
           r.descripcion AS description, r.contacto AS contact,
           r.estado_reporte AS status, r.fecha_reporte AS created_at,
           u.nombre AS reporter_name, u.correo AS reporter_email,
           ST_X(ST_Transform(a.geom, 4326)) AS lon,
           ST_Y(ST_Transform(a.geom, 4326)) AS lat
    FROM public.reportes_alumbrado r
    JOIN public.alumbrado a ON a.gid = r.alumbrado_gid
    LEFT JOIN public.usuarios u ON u.id = r.usuario_id
    ORDER BY r.fecha_reporte DESC
  `);
    await writeAudit(req, req.user, "CONSULTA_REPORTES_ADMIN", {
      count: result.rowCount,
    });
    res.json(result.rows);
  },
);

// PATCH /api/admin/reports/:id/status: cambia el estado de un reporte y registra la acción.
app.patch(
  "/api/admin/reports/:id/status",
  requireRole("administrador"),
  async (req, res) => {
    const id = Number(req.params.id);
    const status = requiredText(req.body?.status, "estado", 30).toUpperCase();
    const allowed = ["RECIBIDO", "EN_REVISION", "RESUELTO", "DESCARTADO"];
    if (!Number.isSafeInteger(id) || id < 1 || !allowed.includes(status)) {
      throw new HttpError(400, "El reporte o el estado no son válidos.");
    }
    const result = await pool.query(
      `UPDATE public.reportes_alumbrado SET estado_reporte = $1
     WHERE id = $2 RETURNING id, estado_reporte AS status`,
      [status, id],
    );
    if (!result.rowCount)
      throw new HttpError(404, "No encontramos ese reporte.");
    await writeAudit(req, req.user, "ESTADO_REPORTE_ACTUALIZADO", {
      report_id: id,
      status,
    });
    res.json(result.rows[0]);
  },
);

// GET /api/admin/audit?limit=200: devuelve los eventos recientes de auditoría con límite
// para mantener la respuesta acotada. Solo está disponible para el rol administrador.
app.get("/api/admin/audit", requireRole("administrador"), async (req, res) => {
  const requested = Number(req.query.limit || 200);
  const limit = Number.isInteger(requested)
    ? Math.max(1, Math.min(requested, 500))
    : 200;
  const result = await pool.query(
    `SELECT correo AS email, accion AS action, detalles AS details,
            direccion_ip AS ip_address, agente_usuario AS user_agent,
            creado_en AS created_at
     FROM public.auditoria_usuario ORDER BY creado_en DESC LIMIT $1`,
    [limit],
  );
  await writeAudit(req, req.user, "CONSULTA_AUDITORIA", { limit });
  res.json(result.rows);
});

app.use(express.static(frontendDir));
app.use((err, _req, res, _next) => {
  if (err instanceof HttpError)
    return res.status(err.status).json({ detail: err.message });
  if (err instanceof SyntaxError && "body" in err)
    return res
      .status(400)
      .json({ detail: "El cuerpo de la solicitud no contiene JSON válido." });
  console.error(err);
  return res
    .status(500)
    .json({ detail: "Ocurrió un error procesando la solicitud." });
});

// Sin host fijo, Node acepta tanto localhost como 127.0.0.1 en entornos Windows.
app.listen(port, () => {
  console.log(`LuzFlorencia disponible en http://127.0.0.1:${port}`);
});

process.on("SIGINT", async () => {
  await pool.end();
  process.exit(0);
});
