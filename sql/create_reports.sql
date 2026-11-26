-- Tabla para reportes ciudadanos vinculados con el código de la luminaria.
CREATE TABLE IF NOT EXISTS public.reportes_alumbrado (
    id BIGSERIAL PRIMARY KEY,
    alumbrado_gid INTEGER NOT NULL,
    cod_ilumin TEXT NOT NULL,
    tipo_dano VARCHAR(80) NOT NULL,
    descripcion VARCHAR(1000) NOT NULL,
    contacto VARCHAR(120),
    estado_reporte VARCHAR(30) NOT NULL DEFAULT 'RECIBIDO',
    fecha_reporte TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT reportes_alumbrado_luminaria_fk
        FOREIGN KEY (alumbrado_gid) REFERENCES public.alumbrado (gid)
        ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS reportes_alumbrado_codigo_idx
    ON public.reportes_alumbrado (cod_ilumin);
CREATE INDEX IF NOT EXISTS reportes_alumbrado_fecha_idx
    ON public.reportes_alumbrado (fecha_reporte DESC);
