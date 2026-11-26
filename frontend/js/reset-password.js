// POST /api/auth/reset-password valida el token de un solo uso y guarda el nuevo hash de clave.
const resetToken =
  new URLSearchParams(window.location.search).get("token") || "";
if (!resetToken)
  window.showAuthMessage(
    "Falta el enlace de recuperación. Solicita uno nuevo desde la página de inicio de sesión.",
  );

document
  .getElementById("resetForm")
  .addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button[type=submit]");
    const password = document.getElementById("password").value;
    if (!resetToken) return;
    if (password !== document.getElementById("confirmPassword").value) {
      window.showAuthMessage("Las contraseñas no coinciden.");
      return;
    }
    button.disabled = true;
    try {
      const data = await window.authRequest("reset-password", {
        token: resetToken,
        password,
      });
      window.showAuthMessage(data.message, true);
      setTimeout(() => window.location.replace("/pages/login.html"), 1400);
    } catch (error) {
      window.showAuthMessage(error.message);
      button.disabled = false;
    }
  });
