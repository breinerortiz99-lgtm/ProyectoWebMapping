-- Prepara una red derivada para pgRouting 4.x.
-- La capa original public.calles se conserva sin cambios.
-- Se ajustan vértices a una cuadrícula de 25 cm, se insertan nodos en cruces
-- en 2D, y se asignan IDs de vértice a los extremos resultantes.

DROP TABLE IF EXISTS public.calles_ruteo_vertices_pgr CASCADE;
DROP TABLE IF EXISTS public.calles_ruteo CASCADE;

CREATE TABLE public.calles_ruteo AS
SELECT row_number() OVER ()::bigint AS id,
       (segmento).geom::geometry(LineString, 3115) AS geom
FROM (
    SELECT ST_Dump(
        ST_Node(
            ST_UnaryUnion(ST_Collect(ST_SnapToGrid(geom, 0.25)))
        )
    ) AS segmento
    FROM public.calles
) AS noded;

ALTER TABLE public.calles_ruteo ADD PRIMARY KEY (id);
CREATE INDEX calles_ruteo_geom_gix ON public.calles_ruteo USING GIST (geom);

CREATE TABLE public.calles_ruteo_vertices_pgr AS
SELECT row_number() OVER (ORDER BY ST_X(geom), ST_Y(geom))::bigint AS id,
       geom::geometry(Point, 3115) AS geom
FROM (
    SELECT ST_StartPoint(geom) AS geom FROM public.calles_ruteo
    UNION
    SELECT ST_EndPoint(geom) AS geom FROM public.calles_ruteo
) AS extremos;

ALTER TABLE public.calles_ruteo_vertices_pgr ADD PRIMARY KEY (id);
CREATE INDEX calles_ruteo_vertices_geom_gix
    ON public.calles_ruteo_vertices_pgr USING GIST (geom);

ALTER TABLE public.calles_ruteo
    ADD COLUMN source bigint,
    ADD COLUMN target bigint,
    ADD COLUMN length_m double precision,
    ADD COLUMN cost double precision,
    ADD COLUMN reverse_cost double precision;

UPDATE public.calles_ruteo AS e
SET source = s.id,
    target = t.id,
    length_m = ST_Length(e.geom),
    cost = ST_Length(e.geom),
    reverse_cost = ST_Length(e.geom)
FROM public.calles_ruteo_vertices_pgr AS s,
     public.calles_ruteo_vertices_pgr AS t
WHERE s.geom = ST_StartPoint(e.geom)
  AND t.geom = ST_EndPoint(e.geom);

ANALYZE public.calles_ruteo;
ANALYZE public.calles_ruteo_vertices_pgr;

SELECT count(*) AS edges,
       count(*) FILTER (WHERE source IS NULL OR target IS NULL) AS edges_without_nodes,
       (SELECT count(*) FROM public.calles_ruteo_vertices_pgr) AS vertices
FROM public.calles_ruteo;
