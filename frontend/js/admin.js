// Cliente REST del panel administrativo: envía peticiones y convierte errores HTTP
// en mensajes útiles; si la sesión o el rol no sirven, vuelve a la vista adecuada.
async function api(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    window.location.replace("/pages/login.html");
    throw new Error("Tu sesión venció.");
  }
  if (response.status === 403) {
    window.location.replace("/pages/visor.html");
    throw new Error("Esta sección requiere el rol administrador.");
  }
  if (!response.ok)
    throw new Error(data.detail || "No se pudo cargar la información.");
  return data;
}

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
}
const dateText = (value) =>
  new Date(value).toLocaleString("es-CO", {
    dateStyle: "short",
    timeStyle: "short",
  });

// 1. Se crea primero el mapa Leaflet. Las capas base y las capas vectoriales se agregan después.
const adminMap = L.map("adminMap", { preferCanvas: true }).setView(
  [1.6144, -75.6062],
  13,
);
const satellite = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  {
    maxZoom: 19,
    attribution:
      "Tiles © Esri — Sources: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
  },
).addTo(adminMap);
const streetMap = L.tileLayer(
  "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  { maxZoom: 19, attribution: "© OpenStreetMap contributors" },
);

// Prepara una ventana con atributos para los elementos que se pulsan en las capas del administrador.
function adminFeaturePopup(feature, layer) {
  const properties = feature.properties || {};
  const title =
    properties.nombre ||
    properties.cod_ilumin ||
    properties.codigo ||
    "Elemento del mapa";
  const rows = Object.entries(properties)
    .filter(
      ([key, value]) =>
        key !== "gid" && value != null && typeof value !== "object",
    )
    .slice(0, 8);
  layer.bindPopup(
    "<strong>" +
      escapeHtml(title) +
      "</strong>" +
      rows
        .map(
          ([key, value]) =>
            "<br><span>" + escapeHtml(key) + ":</span> " + escapeHtml(value),
        )
        .join(""),
  );
}
function adminLampColor(status) {
  const value = String(status || "").toUpperCase();
  if (value.includes("BUENO")) return "#3a9369";
  if (value.includes("REGULAR")) return "#d7a52f";
  if (value.includes("MALO")) return "#d75b52";
  return "#82919b";
}
// 2. Cada L.geoJSON define una capa vacía, su estilo y qué ventana mostrar al seleccionarla.
// Los datos no están escritos aquí: loadAdminMapLayers los solicita a /api/layers/:name.
const reportLayer = L.layerGroup().addTo(adminMap);
const barrioLayer = L.geoJSON(null, {
  style: {
    color: "#378c83",
    weight: 1.2,
    fillColor: "#43a4a0",
    fillOpacity: 0.12,
  },
  onEachFeature: adminFeaturePopup,
}).addTo(adminMap);
const streetLayer = L.geoJSON(null, {
  style: { color: "#507f9e", weight: 1.5, opacity: 0.8 },
  onEachFeature: adminFeaturePopup,
}).addTo(adminMap);
const blockLayer = L.geoJSON(null, {
  style: {
    color: "#9a78a8",
    weight: 0.8,
    fillColor: "#9a78a8",
    fillOpacity: 0.06,
  },
  onEachFeature: adminFeaturePopup,
}).addTo(adminMap);
const lampLayer = L.geoJSON(null, {
  pointToLayer: (feature, latlng) =>
    L.circleMarker(latlng, {
      radius: 4,
      color: "#fff",
      weight: 1,
      fillColor: adminLampColor(feature.properties?.est_ilumin),
      fillOpacity: 0.9,
    }),
  onEachFeature: adminFeaturePopup,
});
const adminVectorEntries = [
  // El nombre debe coincidir con una clave de spatialLayers en backend/server.js.
  // La capa asociada es la que recibirá el GeoJSON que devuelva la API.
  { name: "barrios", layer: barrioLayer },
  { name: "calles", layer: streetLayer },
  { name: "manzanas", layer: blockLayer },
  { name: "alumbrado", layer: lampLayer },
];
const fullGroupLayer = L.layerGroup(
  // Agrupa las cuatro capas para poder encenderlas o apagarlas en conjunto.
  adminVectorEntries.map(({ layer }) => layer),
);
L.control
  .layers(
    { "Imagen satelital": satellite, "Mapa de calles": streetMap },
    {
      "Reportes ciudadanos": reportLayer,
      Luminarias: lampLayer,
      Barrios: barrioLayer,
      Calles: streetLayer,
      Manzanas: blockLayer,
      "Grupo completo de capas": fullGroupLayer,
    },
    { collapsed: true },
  )
  .addTo(adminMap);
L.control.scale({ imperial: false }).addTo(adminMap);

// Permite desplegar la leyenda cuando se necesite sin cubrir el mapa en pantallas pequeñas.
const adminLegend = L.control({ position: "bottomright" });
adminLegend.onAdd = () => {
  const container = L.DomUtil.create("section", "admin-legend leaflet-control");
  container.innerHTML = `<button class="admin-legend-toggle" type="button" aria-expanded="false">
    <span>▤ Leyenda</span><span class="legend-chevron">▾</span>
  </button>
  <div class="admin-legend-content" hidden>
    <p>Reportes</p><div><i class="legend-dot report-open"></i>Recibido / en revisión</div>
    <div><i class="legend-dot report-done"></i>Resuelto</div>
    <p>Estado de luminarias</p><div><i class="legend-dot lamp-good"></i>Bueno</div>
    <div><i class="legend-dot lamp-regular"></i>Regular</div>
    <div><i class="legend-dot lamp-bad"></i>Malo</div>
    <div><i class="legend-dot lamp-unknown"></i>No existe / otro</div>
    <p>Capas urbanas</p><div><i class="legend-fill"></i>Barrios y manzanas</div>
    <div><i class="legend-line"></i>Calles</div>
  </div>`;
  const toggle = container.querySelector(".admin-legend-toggle");
  const content = container.querySelector(".admin-legend-content");
  toggle.addEventListener("click", () => {
    content.hidden = !content.hidden;
    toggle.setAttribute("aria-expanded", String(!content.hidden));
    toggle.querySelector(".legend-chevron").textContent = content.hidden
      ? "▾"
      : "▴";
  });
  L.DomEvent.disableClickPropagation(container);
  return container;
};
adminLegend.addTo(adminMap);

// Mantiene minimizado el minimapa al inicio para dejar más espacio al mapa de reportes.
const adminMiniMapLayer = L.tileLayer(
  "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  {
    attribution: "© OpenStreetMap",
  },
);
if (L.Control.MiniMap) {
  new L.Control.MiniMap(adminMiniMapLayer, {
    position: "bottomleft",
    width: 145,
    height: 100,
    zoomLevelOffset: -5,
    toggleDisplay: true,
    minimized: true,
  }).addTo(adminMap);
}

let adminLayerSequence = 0;
let adminLayerTimer = null;
async function loadAdminMapLayers() {
  // Solo consulta las capas activas para reducir transferencias y trabajo en la base de datos.
  const visible = adminVectorEntries.filter(({ layer }) =>
    adminMap.hasLayer(layer),
  );
  if (!visible.length) return;
  const sequence = ++adminLayerSequence;
  const bbox = adminMap.getBounds().toBBoxString();
  try {
    // Envía a la API el nombre de la capa y los límites visibles del mapa.
    const results = await Promise.all(
      visible.map(async (entry) => ({
        entry,
        data: await api(
          "/api/layers/" + entry.name + "?bbox=" + encodeURIComponent(bbox),
        ),
      })),
    );
    if (sequence !== adminLayerSequence) return;
    // Leaflet reemplaza los elementos del área anterior por los del nuevo GeoJSON.
    for (const { entry, data } of results) {
      entry.layer.clearLayers();
      entry.layer.addData(data);
    }
  } catch (error) {
    console.error("No se pudieron cargar las capas del administrador:", error);
    document.getElementById("adminMapStatus").textContent = error.message;
  }
}
function scheduleAdminLayerLoad() {
  clearTimeout(adminLayerTimer);
  adminLayerTimer = setTimeout(() => void loadAdminMapLayers(), 180);
}
adminMap.on("moveend", scheduleAdminLayerLoad);
adminMap.on("overlayadd", (event) => {
  if (
    adminVectorEntries.some(({ layer }) => layer === event.layer) ||
    event.layer === fullGroupLayer
  )
    scheduleAdminLayerLoad();
});
let allReports = [];
const summaryElements = {
  // Estas claves coinciden con los nombres snake_case que devuelve la API.
  total_reports: "totalReports",
  total_users: "totalUsers",
  users_today: "usersToday",
  resolved_reports: "resolvedReports",
};

// Consulta los totales de administración y actualiza las tarjetas de resumen.
async function loadSummary() {
  const data = await api("/api/admin/summary");
  for (const [key, id] of Object.entries(summaryElements)) {
    document.getElementById(id).textContent = Number(
      data[key] || 0,
    ).toLocaleString("es-CO");
  }
  document.getElementById("pendingReports").textContent = (
    Number(data.received_reports || 0) + Number(data.in_review_reports || 0)
  ).toLocaleString("es-CO");
}

// Dibuja un punto destacado en la ubicación de la luminaria asociada a cada reporte.
function drawReportMarkers(reports) {
  reportLayer.clearLayers();
  for (const report of reports) {
    if (
      !Number.isFinite(Number(report.lat)) ||
      !Number.isFinite(Number(report.lon))
    )
      continue;
    const marker = L.circleMarker([Number(report.lat), Number(report.lon)], {
      radius: 7,
      color: "#fff",
      weight: 2,
      fillColor: report.status === "RESUELTO" ? "#3a9369" : "#e7793e",
      fillOpacity: 1,
    });
    marker.bindPopup(
      `<div class="report-popup"><strong>Reporte #${escapeHtml(report.id)} · ${escapeHtml(report.code)}</strong><br>${escapeHtml(report.damage_type)}<br>${escapeHtml(report.status)} · ${escapeHtml(dateText(report.created_at))}<br>${escapeHtml(report.description)}</div>`,
    );
    marker.on("click", () => selectReport(report.id));
    reportLayer.addLayer(marker);
  }
}

function selectReport(id) {
  const report = allReports.find((row) => Number(row.id) === Number(id));
  if (
    report &&
    Number.isFinite(Number(report.lat)) &&
    Number.isFinite(Number(report.lon))
  ) {
    adminMap.flyTo(
      [Number(report.lat), Number(report.lon)],
      Math.max(16, adminMap.getZoom()),
      { duration: 0.4 },
    );
  }
}

// Construye la tabla de reportes, protege el texto mostrado y añade selectores de estado.
function renderReports() {
  const filter = document.getElementById("statusFilter").value;
  const reports = filter
    ? allReports.filter((report) => report.status === filter)
    : allReports;
  const tbody = document.getElementById("reportRows");
  document.getElementById("reportCount").textContent =
    `${reports.length.toLocaleString("es-CO")} de ${allReports.length.toLocaleString("es-CO")} reportes`;
  if (!reports.length) {
    tbody.innerHTML =
      '<tr><td class="empty-row" colspan="6">Todavía no hay reportes para mostrar.</td></tr>';
    return;
  }
  tbody.innerHTML = reports
    .map(
      (report) => `
    <tr class="report-row" data-report-id="${Number(report.id)}">
      <td>${escapeHtml(dateText(report.created_at))}</td>
      <td><strong>${escapeHtml(report.code)}</strong></td>
      <td>${escapeHtml(report.damage_type)}</td>
      <td>${escapeHtml(report.reporter_name || report.reporter_email || "Cuenta histórica")}</td>
      <td><select class="status-select" aria-label="Estado del reporte ${Number(report.id)}" data-status-id="${Number(report.id)}">
        ${["RECIBIDO", "EN_REVISION", "RESUELTO", "DESCARTADO"].map((status) => `<option ${report.status === status ? "selected" : ""}>${status}</option>`).join("")}
      </select></td>
      <td>${Number.isFinite(Number(report.lat)) ? `${Number(report.lat).toFixed(5)}, ${Number(report.lon).toFixed(5)}` : "Sin coordenadas"}</td>
    </tr>`,
    )
    .join("");
  tbody.querySelectorAll(".report-row").forEach((row) =>
    row.addEventListener("click", (event) => {
      if (!event.target.closest("select")) selectReport(row.dataset.reportId);
    }),
  );
  tbody
    .querySelectorAll(".status-select")
    .forEach((select) => select.addEventListener("change", updateReportStatus));
}

async function loadReports() {
  allReports = await api("/api/admin/reports");
  drawReportMarkers(allReports);
  renderReports();
  document.getElementById("adminMapStatus").textContent =
    `${allReports.length.toLocaleString("es-CO")} reportes en el mapa`;
}

// Cambia el estado del reporte y actualiza el mapa, la tabla y los conteos del panel.
async function updateReportStatus(event) {
  const select = event.currentTarget;
  select.disabled = true;
  try {
    await api(`/api/admin/reports/${select.dataset.statusId}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: select.value }),
    });
    const changedReport = allReports.find(
      (report) => Number(report.id) === Number(select.dataset.statusId),
    );
    if (changedReport) changedReport.status = select.value;
    // Refleja de inmediato el estado guardado en el mapa y en la tabla.
    drawReportMarkers(allReports);
    renderReports();
    await Promise.all([
      loadSummary(),
      loadReports(),
      loadAudit(),
      loadAdminMapLayers(),
    ]);
  } catch (error) {
    window.alert(error.message);
    select.disabled = false;
  }
}

// Muestra los eventos recientes de auditoría, la cuenta relacionada y los detalles de la acción.
async function loadAudit() {
  const rows = await api("/api/admin/audit?limit=200");
  const tbody = document.getElementById("auditRows");
  if (!rows.length) {
    tbody.innerHTML =
      '<tr><td class="empty-row" colspan="5">Aún no hay actividad registrada.</td></tr>';
    return;
  }
  tbody.innerHTML = rows
    .map(
      (row) => `<tr>
    <td>${escapeHtml(dateText(row.created_at))}</td><td>${escapeHtml(row.email || "Cuenta no identificada")}</td>
    <td><strong>${escapeHtml(row.action)}</strong></td>
    <td class="audit-details">${escapeHtml(JSON.stringify(row.details || {}))}</td><td>${escapeHtml(row.ip_address || "—")}</td>
  </tr>`,
    )
    .join("");
}

// Verifica el rol antes de mostrar el panel; la API también aplica esta restricción.
async function initializeAdmin() {
  try {
    const response = await api("/api/auth/me?page=administrador");
    if (response.user.role !== "administrador") {
      window.location.replace("/pages/visor.html");
      return;
    }
    document.getElementById("adminName").textContent = response.user.name;
    await Promise.all([
      loadSummary(),
      loadReports(),
      loadAudit(),
      loadAdminMapLayers(),
    ]);
  } catch (error) {
    document.getElementById("adminMapStatus").textContent = error.message;
  }
}

document
  .getElementById("statusFilter")
  .addEventListener("change", renderReports);
document
  .getElementById("refreshDashboard")
  .addEventListener("click", () =>
    Promise.all([
      loadSummary(),
      loadReports(),
      loadAudit(),
      loadAdminMapLayers(),
    ]),
  );
document.getElementById("adminLogout").addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } finally {
    window.location.replace("/");
  }
});
initializeAdmin();
