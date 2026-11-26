// POST /api/auth/login verifica la cuenta; según su rol, abre el visor de usuario o el administrativo.
document.getElementById("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  window.showAuthMessage("");
  try {
    const data = await window.authRequest("login", {
      email: document.getElementById("email").value,
      password: document.getElementById("password").value,
    });
    window.location.replace(data.user.role === "administrador" ? "/pages/admin.html" : "/pages/visor.html");
  } catch (error) {
    window.showAuthMessage(error.message);
    button.disabled = false;
  }
});
