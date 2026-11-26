// Funciones compartidas por registro, acceso y recuperación; centralizan el envío a la API
// y la presentación de mensajes sin mezclar los estilos independientes de cada página.
window.authRequest = async function authRequest(path, body) {
  // Envía JSON al endpoint de autenticación seleccionado y convierte respuestas de error en mensajes.
  const response = await fetch(`/api/auth/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || "No fue posible completar la solicitud.");
  return data;
};

window.showAuthMessage = function showAuthMessage(message, success = false) {
  // Presenta el resultado de la operación junto al formulario correspondiente.
  const field = document.getElementById("formMessage");
  field.textContent = message;
  field.classList.toggle("success", success);
};
