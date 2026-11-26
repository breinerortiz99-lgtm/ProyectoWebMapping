// POST /api/auth/register crea una cuenta pública de usuario; el rol administrador se asigna aparte.
document.getElementById("registerForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  const password = document.getElementById("password").value;
  if (password !== document.getElementById("confirmPassword").value) {
    window.showAuthMessage("Las contraseñas no coinciden.");
    return;
  }
  button.disabled = true;
  window.showAuthMessage("");
  try {
    await window.authRequest("register", {
      name: document.getElementById("name").value,
      email: document.getElementById("email").value,
      password,
    });
    window.location.replace("/pages/visor.html");
  } catch (error) {
    window.showAuthMessage(error.message);
    button.disabled = false;
  }
});
