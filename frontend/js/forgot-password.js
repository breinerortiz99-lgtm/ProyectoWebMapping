// POST /api/auth/forgot-password solicita el correo de recuperación; el mensaje no revela
// si la dirección está registrada, para proteger la privacidad de las cuentas.
document.getElementById("forgotForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const data = await window.authRequest("forgot-password", {
      email: document.getElementById("email").value,
    });
    window.showAuthMessage(data.message, true);
  } catch (error) {
    window.showAuthMessage(error.message);
  } finally { button.disabled = false; }
});
