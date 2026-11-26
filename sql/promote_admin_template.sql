-- Replace the email below with an account created from the public registration page.
-- Run this statement in pgAdmin to grant administrator access to that account.
UPDATE public.usuarios
SET rol = 'administrador'
WHERE correo = lower('cambia-por-el-correo-administrador@example.com');

-- Public registration intentionally never accepts rol from the browser.
