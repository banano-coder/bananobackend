-- =====================================================================
-- MIGRACIÓN: Agregar campo es_efectivo a tabla cuenta
-- Fecha: 2026-08-03
-- =====================================================================

-- 1. Agregar columna es_efectivo
ALTER TABLE public.cuenta 
  ADD COLUMN IF NOT EXISTS es_efectivo boolean DEFAULT false NOT NULL;

-- 2. Comentario descriptivo
COMMENT ON COLUMN public.cuenta.es_efectivo IS 
  'Indica si esta cuenta es la caja de efectivo principal de la sede (id_almacen). 
   Cuando hay pagos en efectivo en el POS, el sistema busca automaticamente 
   la cuenta con es_efectivo=true del almacen del vendedor.';

-- 3. (Opcional) Marcar cuentas existentes de efectivo manualmente:
-- UPDATE public.cuenta SET es_efectivo = true WHERE nombre ILIKE '%Efectivo%' AND id_almacen IS NOT NULL;

-- 4. Verificar resultado
SELECT id_cuenta, nombre, moneda, id_almacen, es_cashea, es_efectivo 
FROM public.cuenta 
WHERE eliminado = false 
ORDER BY id_almacen, nombre;
