const API = "";
const MAP_CENTER = [1.6144, -75.6062];
const $ = (id) => document.getElementById(id);
// Inicializa el mapa en Florencia y prepara paneles visuales para que los puntos destacados
// del análisis de proximidad se dibujen encima de las luminarias agrupadas.
const map = L.map("map", { zoomControl: false, preferCanvas: true }).setView(
  MAP_CENTER,
  13,
);
// Mantiene los puntos del análisis por encima de las luminarias agrupadas.
map.createPane("lampPointsPane");
map.getPane("lampPointsPane").style.zIndex = 410;
map.createPane("proximityMarkersPane");
map.getPane("proximityMarkersPane").style.zIndex = 620;
const lampCanvasRenderer = L.canvas({ padding: 0.3, pane: "lampPointsPane" });
L.control.zoom({ position: "topright" }).addTo(map);

const imagery = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  {
    maxZoom: 19,
    attribution:
      "Tiles © Esri — Sources: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
  },
);
const streetBase = L.tileLayer(
  "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  {
    maxZoom: 19,
    attribution: "© OpenStreetMap contributors",
  },
);
imagery.addTo(map);

// Añade una etiqueta breve a las capas territoriales cuando el elemento tiene nombre o código.
function vectorTooltip(feature, layer) {
  const properties = feature.properties || {};
  const label = properties.nombre || properties.codigo || properties.cod_ilumin;
  if (label) layer.bindTooltip(String(label), { sticky: true });
}
function lampColor(status) {
  const value = String(status || "").toUpperCase();
  if (value.includes("BUENO")) return "#54a96b";
  if (value.includes("REGULAR")) return "#e4b544";
  if (value.includes("MALO")) return "#d75b52";
  if (value.includes("NO EXISTE")) return "#929da5";
  return "#638ba5";
}
function lampIcon(status) {
  const color = lampColor(status);
  return L.divIcon({
    className: "lamp-point-icon",
    html: `<span class="lamp-point" style="--lamp-color:${color}"></span>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}
// 1. Las capas GeoJSON nacen vacías; la API Node/PostGIS entrega sus entidades al activar la capa.
// Para agregar otra capa, definir aquí su estilo, añadirla a vectorLayerEntries y al control.
const lampCluster = L.layerGroup().addTo(map);
const barrioLayer = L.geoJSON(null, {
  style: {
    color: "#378c83",
    weight: 1.2,
    fillColor: "#43a4a0",
    fillOpacity: 0.12,
  },
  onEachFeature: vectorTooltip,
}).addTo(map);
const streetLayer = L.geoJSON(null, {
  style: { color: "#507f9e", weight: 1.5, opacity: 0.8 },
  onEachFeature: vectorTooltip,
}).addTo(map);
const blockLayer = L.geoJSON(null, {
  style: {
    color: "#9a78a8",
    weight: 0.8,
    fillColor: "#9a78a8",
    fillOpacity: 0.06,
  },
  onEachFeature: vectorTooltip,
}).addTo(map);
const vectorLayerEntries = [
  { name: "barrios", layer: barrioLayer },
  { name: "calles", layer: streetLayer },
  { name: "manzanas", layer: blockLayer },
];
// Este grupo incluye las capas vectoriales y el conjunto agrupado de luminarias.
const groupedOverlay = L.layerGroup([
  lampCluster,
  barrioLayer,
  streetLayer,
  blockLayer,
]);
const neighborhoods = {
  "Luminarias agrupadas": lampCluster,
  Barrios: barrioLayer,
  Calles: streetLayer,
  Manzanas: blockLayer,
  "Grupo completo de capas": groupedOverlay,
};
L.control
  .layers(
    { "Imagen satelital": imagery, "Mapa de calles": streetBase },
    neighborhoods,
    { collapsed: true, position: "topright" },
  )
  .addTo(map);
L.control.scale({ imperial: false, position: "bottomleft" }).addTo(map);

const legend = L.control({ position: "bottomright" });

legend.onAdd = () => {
  const div = L.DomUtil.create("div", "legend");

  div.innerHTML = `
    <button class="legend-toggle" type="button">
      ☰ Leyenda <span>▼</span>
    </button>

    <div class="legend-content">
      <div class="legend-row"><i class="legend-dot" style="background:#54a96b"></i>Bueno</div>
      <div class="legend-row"><i class="legend-dot" style="background:#e4b544"></i>Regular</div>
      <div class="legend-row"><i class="legend-dot" style="background:#d75b52"></i>Malo</div>
      <div class="legend-row"><i class="legend-dot" style="background:#929da5"></i>No existe / otro</div>
      <div class="legend-row"><i class="legend-fill"></i>Barrios</div>
      <div class="legend-row"><i class="legend-line"></i>Calles</div>
    </div>
  `;

  const button = div.querySelector(".legend-toggle");
  const content = div.querySelector(".legend-content");

  button.addEventListener("click", () => {
    content.classList.toggle("hidden");
    button.querySelector("span").textContent = content.classList.contains(
      "hidden",
    )
      ? "▲"
      : "▼";
  });

  L.DomEvent.disableClickPropagation(div);

  return div;
};

legend.addTo(map);
const miniLayer = L.tileLayer(
  "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  { attribution: "© OpenStreetMap" },
);
if (L.Control.MiniMap)
  new L.Control.MiniMap(miniLayer, {
    position: "bottomleft",
    width: 145,
    height: 100,
    zoomLevelOffset: -5,
    toggleDisplay: true,
    minimized: false,
  }).addTo(map);

let vectorLoadSequence = 0;
let vectorLoadTimer = null;
async function loadVisibleVectorLayers() {
  // Solo solicita las capas vectoriales que el usuario dejó visibles en el control de Leaflet.
  const visible = vectorLayerEntries.filter(({ layer }) => map.hasLayer(layer));
  if (!visible.length) return;
  const sequence = ++vectorLoadSequence;
  const bbox = map.getBounds().toBBoxString();
  try {
    // Cada solicitud corresponde a GET /api/layers/:name y limita la respuesta al área visible.
    const results = await Promise.all(
      visible.map(async (entry) => ({
        entry,
        data: await request(
          "/api/layers/" + entry.name + "?bbox=" + encodeURIComponent(bbox),
        ),
      })),
    );
    if (sequence !== vectorLoadSequence) return;
    // Conserva el estilo Leaflet definido para esa capa y reemplaza únicamente sus entidades.
    for (const { entry, data } of results) {
      entry.layer.clearLayers();
      entry.layer.addData(data);
    }
  } catch (error) {
    console.error("No se pudieron cargar las capas vectoriales:", error);
    setMessage(error.message, true);
  }
}
function scheduleVectorLayerLoad() {
  clearTimeout(vectorLoadTimer);
  vectorLoadTimer = setTimeout(() => void loadVisibleVectorLayers(), 180);
}
let selectedLamp = null;
let destinationPoint = null;
let selectionMode = false;
let destinationMarker = null;
let routeLine = null;
let routeStartMarker = null;
let routeEndMarker = null;
let proximityCircle = null;
let proximityLocationMarker = null;
const proximityLayer = L.layerGroup().addTo(map);
let lampIndex = null;
let renderTimer = null;
let lampSelectionRequest = 0;
const statusText = (v) =>
  v == null || String(v).trim() === "" ? "Sin dato" : String(v);
const titleCase = (v) =>
  String(v || "")
    .toLowerCase()
    .replace(/\b\p{L}/gu, (c) => c.toUpperCase());

async function request(path, options) {
  // Todas las funciones del visor usan este cliente para comunicarse con la API REST.
  const response = await fetch(`${API}${path}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(data.detail || "No fue posible completar la solicitud.");
  return data;
}
function setMessage(message, error = false) {
  $("mapMessage").textContent = message;
  $("mapMessage").classList.toggle("error", error);
}
function statusClass(value) {
  const s = String(value || "").toUpperCase();
  if (s.includes("BUENO")) return "good";
  if (s.includes("REGULAR")) return "regular";
  if (s.includes("MALO") || s.includes("NO EXISTE")) return "bad";
  return "";
}
function displayLamp(lamp, extra = {}) {
  // Actualiza la ficha lateral y el popup del mapa con atributos de la luminaria seleccionada.
  selectedLamp = lamp;
  const props = lamp.properties || {};
  const code = props.cod_ilumin ?? lamp.code ?? "Luminaria";
  const status = props.est_ilumin ?? "Sin dato";
  $("lampTitle").textContent = code;
  $("lampStatus").textContent = statusText(status);
  $("lampStatus").className = `status-pill ${statusClass(status)}`;
  const entries = Object.entries(props)
    .filter(
      ([key, value]) =>
        !["geom", "geometry"].includes(key) && value !== null && value !== "",
    )
    .slice(0, 6);
  $("lampDetails").innerHTML = entries
    .map(
      ([key, value]) =>
        `<div><dt>${escapeHtml(titleCase(key.replaceAll("_", " ")))}</dt><dd>${escapeHtml(String(value))}</dd></div>`,
    )
    .join("");
  // El popup muestra todos los atributos no vacíos que entrega la API para esta luminaria.
  const popupAttributes = Object.entries(props)
    .filter(
      ([key, value]) =>
        !["geom", "geometry"].includes(key) && value !== null && value !== "",
    )
    .map(
      ([key, value]) =>
        `<div><dt>${escapeHtml(titleCase(key.replaceAll("_", " ")))}</dt><dd>${escapeHtml(String(value))}</dd></div>`,
    )
    .join("");
  const distanceAttribute = Number.isFinite(Number(extra.distance_m))
    ? `<div><dt>Distancia desde tu ubicación</dt><dd>${escapeHtml(String(extra.distance_m))} m</dd></div>`
    : "";
  const popupHtml =
    `<div class="lamp-popup"><strong>Luminaria ${escapeHtml(String(code))}</strong>` +
    `<span class="lamp-popup-status">${escapeHtml(statusText(status))}</span>` +
    `<dl>${distanceAttribute}${popupAttributes}</dl></div>`;
  $("lampCard").classList.remove("hidden");
  const [lon, lat] = lamp.coordinates;
  // El popup no crea un marcador adicional y cerrar uno permite seleccionar otra luminaria.
  L.popup({ maxWidth: 340, maxHeight: 280, autoPan: true })
    .setLatLng([lat, lon])
    .setContent(popupHtml)
    .openOn(map);
  map.flyTo([lat, lon], Math.max(16, map.getZoom()), { duration: 0.45 });
  setMessage(`Luminaria ${code} localizada`);
}

// Usa la misma consulta completa y el mismo popup para cualquier forma de seleccionar una luz.
async function selectLampByCode(code, extra = {}) {
  // GET /api/lamps/search?code=... devuelve los atributos completos también para puntos fuera del buffer.
  const requestId = ++lampSelectionRequest;
  setMessage(`Consultando luminaria ${code}…`);
  try {
    const lamp = await request(
      "/api/lamps/search?code=" + encodeURIComponent(code),
    );
    if (requestId !== lampSelectionRequest) return null;
    displayLamp(lamp, extra);
    return lamp;
  } catch (error) {
    if (requestId === lampSelectionRequest) setMessage(error.message, true);
    return null;
  }
}
function escapeHtml(str) {
  return str.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

$("searchForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = $("lampCode").value.trim();
  if (!code) return;
  setMessage("Buscando luminaria…");
  const lamp = await selectLampByCode(code);
  if (!lamp) {
    $("lampCard").classList.add("hidden");
  }
});

async function loadSummary() {
  // GET /api/summary obtiene la cantidad de luminarias agrupadas por estado.
  try {
    const rows = await request("/api/summary");
    $("statusSummary").innerHTML = rows
      .map(
        (row) =>
          `<div class="summary-item">${escapeHtml(statusText(row.estado))}<strong>${Number(row.total).toLocaleString("es-CO")}</strong></div>`,
      )
      .join("");
  } catch {
    $("statusSummary").innerHTML =
      '<span class="loading">Inicia el servicio para cargar el resumen.</span>';
  }
}
function clusterIcon(count) {
  const size = count < 20 ? "small" : count < 100 ? "medium" : "large";
  return L.divIcon({
    html: `<span>${count.toLocaleString("es-CO")}</span>`,
    className: `lamp-cluster-icon ${size}`,
    iconSize: [46, 46],
  });
}

function visibleBounds() {
  const bounds = map.getBounds().pad(0.15);
  return [
    bounds.getWest(),
    bounds.getSouth(),
    bounds.getEast(),
    bounds.getNorth(),
  ];
}

function renderLampClusters() {
  // Supercluster calcula grupos según el nivel de zoom; Leaflet solo dibuja lo que cabe en pantalla.
  if (!lampIndex || !map.hasLayer(lampCluster)) return;
  if (renderTimer) cancelAnimationFrame(renderTimer);
  renderTimer = requestAnimationFrame(() => {
    const zoom = Math.floor(map.getZoom());
    const features = lampIndex.getClusters(visibleBounds(), zoom);
    const visibleLayers = [];

    for (const feature of features) {
      const [lon, lat] = feature.geometry.coordinates;
      const properties = feature.properties || {};
      if (properties.cluster) {
        const count = properties.point_count;
        const marker = L.marker([lat, lon], {
          icon: clusterIcon(count),
          keyboard: false,
          title: `${count} luminarias`,
        });
        marker.on("click", () => {
          const nextZoom = lampIndex.getClusterExpansionZoom(
            properties.cluster_id,
          );
          map.flyTo([lat, lon], Math.min(nextZoom, 19), { duration: 0.45 });
        });
        visibleLayers.push(marker);
      } else {
        const marker = L.circleMarker([lat, lon], {
          renderer: lampCanvasRenderer,
          radius: 5,
          color: "#fff",
          weight: 1.5,
          fillColor: lampColor(properties.est_ilumin),
          fillOpacity: 0.95,
        });
        // Muestra atributos útiles al pasar el cursor sin consultar la API por cada punto.
        const code = escapeHtml(String(properties.cod_ilumin || "Sin código"));
        const hoverInfo =
          `<strong>Luminaria ${code}</strong><br>Estado: ${escapeHtml(statusText(properties.est_ilumin))}` +
          (properties.fuente
            ? `<br>Fuente: ${escapeHtml(String(properties.fuente))}`
            : "") +
          (properties.potencia
            ? `<br>Potencia: ${escapeHtml(String(properties.potencia))}`
            : "") +
          (properties.tipo
            ? `<br>Tipo: ${escapeHtml(String(properties.tipo))}`
            : "");
        marker.bindTooltip(hoverInfo, {
          direction: "top",
          offset: [0, -5],
          sticky: true,
          opacity: 0.97,
        });
        marker.on("click", () => selectLampByCode(properties.cod_ilumin));
        visibleLayers.push(marker);
      }
    }

    lampCluster.clearLayers();
    lampCluster.addLayer(L.layerGroup(visibleLayers));
  });
}

async function loadLampCluster() {
  // Pide la capa de luminarias a la API, construye el índice de agrupamiento y dibuja los grupos.
  // La API convierte a GeoJSON las coordenadas PostGIS; Supercluster reemplaza muchos marcadores
  // individuales por grupos hasta que el usuario acerca el mapa.
  setMessage("Cargando luminarias…");
  try {
    const collection = await request("/api/layers/alumbrado");
    const points = collection.features.filter(
      (feature) => feature.geometry?.type === "Point",
    );
    lampIndex = new Supercluster({
      radius: 60,
      maxZoom: 17,
      minPoints: 2,
      nodeSize: 64,
    }).load(points);
    renderLampClusters();
    setMessage(
      `${points.length.toLocaleString("es-CO")} luminarias listas · acerca o pulsa un grupo para explorarlo`,
    );
  } catch (error) {
    setMessage(error.message, true);
  }
}

map.on("moveend", () => {
  renderLampClusters();
  scheduleVectorLayerLoad();
});
map.on("overlayadd", (event) => {
  if (event.layer === lampCluster) renderLampClusters();
  if (
    event.layer === groupedOverlay ||
    vectorLayerEntries.some(({ layer }) => layer === event.layer)
  )
    scheduleVectorLayerLoad();
});
$("reportButton").addEventListener("click", () => {
  if (!selectedLamp) return;
  $("reportLampCode").textContent =
    selectedLamp.properties.cod_ilumin || selectedLamp.code;
  $("reportFeedback").textContent = "";
  $("reportFeedback").className = "form-feedback";
  $("reportDialog").showModal();
});
$("closeDialog").addEventListener("click", () => $("reportDialog").close());
$("reportForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = $("submitReport");
  submit.disabled = true;
  submit.textContent = "Enviando…";
  const body = {
    code: selectedLamp.properties.cod_ilumin || selectedLamp.code,
    type: $("damageType").value,
    description: $("reportDescription").value.trim(),
    contact: $("reportContact").value.trim(),
  };
  try {
    // POST /api/reports guarda el daño ligado a la luminaria y a la cuenta autenticada.
    const result = await request("/api/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    $("reportFeedback").textContent =
      `Reporte ${result.id} registrado. Gracias por informar.`;
    $("reportFeedback").classList.remove("error");
    $("reportForm").reset();
    setTimeout(() => $("reportDialog").close(), 1300);
  } catch (error) {
    $("reportFeedback").textContent = error.message;
    $("reportFeedback").classList.add("error");
  } finally {
    submit.disabled = false;
    submit.textContent = "Enviar reporte";
  }
});

function showDestination(point, label) {
  destinationPoint = point;
  if (destinationMarker) map.removeLayer(destinationMarker);
  destinationMarker = L.marker([point.lat, point.lon], {
    icon: L.divIcon({
      className: "",
      html: '<div class="route-dest"></div>',
      iconSize: [15, 15],
      iconAnchor: [7, 7],
    }),
  })
    .addTo(map)
    .bindPopup(escapeHtml(label));
  $("destination").value = label;
  setMessage(`Destino seleccionado: ${label}`);
  map.flyTo([point.lat, point.lon], 15, { duration: 0.45 });
  if (selectedLamp) drawRoute();
}
$("destinationSearch").addEventListener("click", () => {
  selectionMode = true;
  setMessage("Pulsa en el mapa para marcar el destino");
});
$("destination").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    selectionMode = true;
    setMessage("Pulsa en el mapa para marcar el destino");
  }
});
$("cityHallButton").addEventListener("click", () =>
  showDestination({ lat: 1.61499, lon: -75.61394 }, "Alcaldía de Florencia"),
);
$("currentLocationButton").addEventListener("click", () => {
  if (!navigator.geolocation) {
    setMessage(
      "Este navegador no permite obtener la ubicación. Puedes marcarla manualmente en el mapa.",
      true,
    );
    return;
  }
  const button = $("currentLocationButton");
  button.disabled = true;
  setMessage("Solicitando permiso para obtener tu ubicación…");
  navigator.geolocation.getCurrentPosition(
    (position) => {
      button.disabled = false;
      showDestination(
        { lat: position.coords.latitude, lon: position.coords.longitude },
        "Mi ubicación actual",
      );
    },
    (error) => {
      button.disabled = false;
      const messages = {
        1: "No se concedió permiso de ubicación. Puedes marcar el punto manualmente en el mapa.",
        2: "No se pudo determinar la ubicación. Intenta de nuevo o marca el punto en el mapa.",
        3: "La ubicación tardó demasiado. Intenta de nuevo o marca el punto en el mapa.",
      };
      setMessage(
        messages[error.code] || "No se pudo obtener la ubicación.",
        true,
      );
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
  );
});
$("chooseOnMap").addEventListener("click", () => {
  selectionMode = true;
  setMessage("Pulsa en el mapa donde está tu residencia");
});
map.on("click", (event) => {
  if (!selectionMode) return;
  selectionMode = false;
  showDestination(
    { lat: event.latlng.lat, lon: event.latlng.lng },
    $("destination").value.trim() || "Destino marcado en el mapa",
  );
});

async function drawRoute() {
  if (!selectedLamp || !destinationPoint) {
    setMessage("Busca una luminaria y elige un destino primero", true);
    return;
  }
  setMessage("Calculando ruta por las calles…");
  try {
    // POST /api/route solicita a PostGIS/pgRouting el recorrido entre luminaria y destino.
    const result = await request("/api/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: selectedLamp.properties.cod_ilumin || selectedLamp.code,
        destination: destinationPoint,
      }),
    });
    // Oculta los puntos y el pin del destino para que la ruta se vea con claridad.
    map.closePopup();
    [lampCluster, proximityLayer].forEach((layer) => {
      if (map.hasLayer(layer)) map.removeLayer(layer);
    });
    if (destinationMarker) {
      map.removeLayer(destinationMarker);
      destinationMarker = null;
    }
    if (routeLine) map.removeLayer(routeLine);
    if (routeStartMarker) map.removeLayer(routeStartMarker);
    if (routeEndMarker) map.removeLayer(routeEndMarker);
    routeLine = L.geoJSON(result.geometry, {
      style: { color: "#ed783f", weight: 5, opacity: 0.92, lineCap: "round" },
    }).addTo(map);
    // Mantiene a la vista los dos extremos de la ruta: luminaria de origen y destino elegido.
    routeStartMarker = L.marker(
      [selectedLamp.coordinates[1], selectedLamp.coordinates[0]],
      {
        icon: L.divIcon({
          className: "route-endpoint-icon",
          html: '<span class="route-origin-symbol" aria-label="Luminaria de inicio">💡</span>',
          iconSize: [34, 42],
          iconAnchor: [17, 38],
        }),
        title: `Inicio: luminaria ${selectedLamp.properties.cod_ilumin || selectedLamp.code}`,
        zIndexOffset: 1000,
      },
    )
      .addTo(map)
      .bindPopup(
        `Inicio · luminaria ${escapeHtml(String(selectedLamp.properties.cod_ilumin || selectedLamp.code))}`,
      );
    const isCurrentLocation = $("destination").value === "Mi ubicación actual";
    routeEndMarker = L.marker([destinationPoint.lat, destinationPoint.lon], {
      icon: L.divIcon({
        className: "route-endpoint-icon",
        html: isCurrentLocation
          ? '<span class="route-current-location" aria-label="Tu ubicación actual"><i></i></span>'
          : '<span class="route-destination-symbol" aria-label="Destino">●</span>',
        iconSize: [36, 44],
        iconAnchor: [18, 40],
      }),
      title: isCurrentLocation ? "Tu ubicación actual" : $("destination").value,
      zIndexOffset: 1100,
    })
      .addTo(map)
      .bindPopup(
        escapeHtml(
          isCurrentLocation
            ? "Tu ubicación actual · destino"
            : $("destination").value,
        ),
      );
    const bounds = L.latLngBounds(
      [selectedLamp.coordinates[1], selectedLamp.coordinates[0]],
      [destinationPoint.lat, destinationPoint.lon],
    );
    routeLine.getBounds().extend(bounds);
    map.fitBounds(routeLine.getBounds(), { padding: [45, 45], maxZoom: 16 });
    setMessage(
      `Ruta aproximada por calles: ${Number(result.distance_m).toLocaleString("es-CO", { maximumFractionDigits: 0 })} m`,
    );
  } catch (error) {
    setMessage(error.message, true);
  }
}
$("routeButton").addEventListener("click", drawRoute);
$("proximityButton").addEventListener("click", async () => {
  // Usa la ubicación actual del usuario como origen y resalta todas las luminarias encontradas.
  if (!navigator.geolocation) {
    $("proximityResult").textContent =
      "Este navegador no permite consultar la ubicación. Usa el botón de ubicación manual en el mapa.";
    return;
  }
  const button = $("proximityButton");
  button.disabled = true;
  $("proximityResult").textContent = "Solicitando permiso de ubicación…";
  navigator.geolocation.getCurrentPosition(
    async (position) => {
      const center = {
        lat: position.coords.latitude,
        lon: position.coords.longitude,
      };
      try {
        // POST /api/proximity busca luces alrededor de la ubicación actual y devuelve puntos resaltables.
        const result = await request("/api/proximity", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ center, radius_m: 100 }),
        });
        proximityLayer.clearLayers();
        proximityCircle = L.circle([center.lat, center.lon], {
          radius: result.radius_m,
          color: "#087b99",
          weight: 2,
          fillColor: "#35acc0",
          fillOpacity: 0.14,
          interactive: false,
          bubblingMouseEvents: false,
        });
        proximityLocationMarker = L.marker([center.lat, center.lon], {
          pane: "proximityMarkersPane",
          icon: L.divIcon({
            className: "proximity-origin-icon",
            html: "<span></span>",
            iconSize: [20, 20],
            iconAnchor: [10, 10],
          }),
        }).bindPopup("Tu ubicación actual");
        proximityLayer.addLayer(proximityCircle);
        proximityLayer.addLayer(proximityLocationMarker);
        const highlighted = L.geoJSON(
          { type: "FeatureCollection", features: result.features },
          {
            pointToLayer(feature, latlng) {
              const properties = feature.properties || {};
              const marker = L.marker(latlng, {
                pane: "proximityMarkersPane",
                icon: L.divIcon({
                  className: "proximity-lamp-icon",
                  html: "<span></span>",
                  iconSize: [18, 18],
                  iconAnchor: [9, 9],
                }),
              });
              const code = String(properties.code || "Sin código");
              const hoverInfo =
                `<strong>Luminaria ${escapeHtml(code)}</strong>` +
                `<br>Estado: ${escapeHtml(String(properties.status || "Sin dato"))}` +
                `<br>Distancia: ${escapeHtml(String(properties.distance_m))} m`;
              marker.bindTooltip(hoverInfo, {
                direction: "top",
                sticky: true,
                opacity: 0.97,
              });
              marker.on("click", () =>
                selectLampByCode(code, {
                  distance_m: Number(properties.distance_m),
                }),
              );
              return marker;
            },
          },
        );
        proximityLayer.addLayer(highlighted);
        const stateSummary = Object.entries(result.by_status)
          .map(([state, count]) => `${state}: ${count}`)
          .join(" · ");
        $("proximityResult").textContent = result.nearby_count
          ? `${result.nearby_count} luminarias a ${result.radius_m} m · ${stateSummary}`
          : `No se encontraron luminarias dentro de ${result.radius_m} m.`;
        map.fitBounds(proximityCircle.getBounds(), {
          padding: [30, 30],
          maxZoom: 18,
        });
        setMessage(`${result.nearby_count} luminarias cercanas resaltadas`);
      } catch (error) {
        $("proximityResult").textContent = error.message;
      } finally {
        button.disabled = false;
      }
    },
    (error) => {
      const messages = {
        1: "No se concedió permiso de ubicación. Puedes intentarlo de nuevo cuando quieras.",
        2: "No se pudo determinar la ubicación. Intenta de nuevo.",
        3: "La ubicación tardó demasiado. Intenta de nuevo.",
      };
      $("proximityResult").textContent =
        messages[error.code] || "No se pudo obtener la ubicación.";
      button.disabled = false;
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
  );
});

async function checkConnection() {
  // GET /api/health comprueba que Node.js puede consultar PostgreSQL.
  try {
    await request("/api/health");
    $("connectionText").textContent = "PostgreSQL conectado";
    document.querySelector(".status-dot").classList.add("online");
  } catch {
    $("connectionText").textContent = "Servicio sin conexión";
  }
}
// Valida la cuenta antes de pedir capas o información privada del mapa.
async function initializeVisor() {
  // GET /api/auth/me valida la sesión y el rol antes de cargar capas o datos privados.
  try {
    const { user } = await request("/api/auth/me?page=visor");
    if (user.role === "administrador") {
      window.location.replace("/pages/admin.html");
      return;
    }
    $("userNameDisplay").textContent = user.name;
    await Promise.all([
      loadSummary(),
      loadLampCluster(),
      loadVisibleVectorLayers(),
      checkConnection(),
    ]);
  } catch {
    window.location.replace("/pages/login.html");
  }
}

// Cierra la sesión en el servidor antes de volver a la página pública.
$("logoutButton").addEventListener("click", async () => {
  try {
    await request("/api/auth/logout", { method: "POST" });
  } finally {
    window.location.replace("/index.html");
  }
});
initializeVisor();
