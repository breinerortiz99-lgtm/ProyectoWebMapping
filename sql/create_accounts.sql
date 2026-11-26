-- Accounts use server-generated roles: public registration always creates usuario.
CREATE TABLE IF NOT EXISTS public.usuarios (
    id BIGSERIAL PRIMARY KEY,
    nombre VARCHAR(120) NOT NULL,
    correo VARCHAR(254) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    rol VARCHAR(20) NOT NULL DEFAULT 'usuario'
        CHECK (rol IN ('usuario', 'administrador')),
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Opaque sessions are stored as SHA-256 hashes; the browser only receives the random token.
CREATE TABLE IF NOT EXISTS public.sesiones_usuario (
    token_hash CHAR(64) PRIMARY KEY,
    usuario_id BIGINT NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
    vence_en TIMESTAMPTZ NOT NULL,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sesiones_usuario_vence_idx
    ON public.sesiones_usuario (vence_en);

-- Audit records cover authentication, map use, reports, routing and proximity analysis.
CREATE TABLE IF NOT EXISTS public.auditoria_usuario (
    id BIGSERIAL PRIMARY KEY,
    usuario_id BIGINT REFERENCES public.usuarios(id) ON DELETE SET NULL,
    correo VARCHAR(254),
    accion VARCHAR(80) NOT NULL,
    detalles JSONB NOT NULL DEFAULT '{}'::jsonb,
    direccion_ip TEXT,
    agente_usuario TEXT,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auditoria_usuario_fecha_idx
    ON public.auditoria_usuario (creado_en DESC);
CREATE INDEX IF NOT EXISTS auditoria_usuario_usuario_idx
    ON public.auditoria_usuario (usuario_id, creado_en DESC);

-- Only a hash of the one-time password recovery token is retained in the database.
CREATE TABLE IF NOT EXISTS public.restablecimiento_clave (
    token_hash CHAR(64) PRIMARY KEY,
    usuario_id BIGINT NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
    vence_en TIMESTAMPTZ NOT NULL,
    usado_en TIMESTAMPTZ,
    creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tie future citizen reports to the signed-in account, while keeping historic rows valid.
ALTER TABLE public.reportes_alumbrado
    ADD COLUMN IF NOT EXISTS usuario_id BIGINT
    REFERENCES public.usuarios(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS reportes_alumbrado_usuario_idx
    ON public.reportes_alumbrado (usuario_id, fecha_reporte DESC);
