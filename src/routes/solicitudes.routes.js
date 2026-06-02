const { Router } = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middlewares/requireAuth');
const inventarioRouter = require('./inventario.routes');


const router = Router();

// 1. CREAR una solicitud (Cualquier usuario autenticado, ej: vendedor)
// POST /api/solicitudes-autorizacion
router.post('/solicitudes-autorizacion', requireAuth, async (req, res, next) => {
    try {
        const { tipo_accion, target_id, target_nombre, motivo, payload } = req.body || {};

        if (!tipo_accion || !target_id || !target_nombre || !motivo) {
            return res.status(400).json({ message: 'Todos los campos son requeridos: tipo_accion, target_id, target_nombre, motivo' });
        }

        const allowedActions = ['ELIMINAR_PRODUCTO', 'ELIMINAR_VARIANTE', 'REGISTRAR_SALIDA', 'TRANSFERIR_STOCK', 'ANULAR_VENTA'];
        if (!allowedActions.includes(tipo_accion)) {
            return res.status(400).json({ message: 'Acción no permitida para solicitar autorización' });
        }

        const id_solicitante = req.user.id || req.user.sub;

        const { rows } = await pool.query(
            `INSERT INTO public.solicitud_autorizacion 
               (id_usuario_solicitante, tipo_accion, target_id, target_nombre, motivo, estado, fecha_creacion, payload)
             VALUES ($1, $2, $3, $4, $5, 'pendiente', NOW(), $6::jsonb)
             RETURNING *`,
            [id_solicitante, tipo_accion, target_id, target_nombre, motivo, payload ? JSON.stringify(payload) : null]
        );

        // Crear registro en la tabla de auditoría para dejar registro de la solicitud
        await pool.query(
            `INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
             VALUES ($1, 'solicitud_autorizacion', 'REQUEST_CREATE', $2::jsonb, NOW())`,
            [id_solicitante, JSON.stringify({ id_solicitud: rows[0].id_solicitud, tipo_accion, target_id, target_nombre })]
        );

        res.status(201).json({ message: 'Solicitud creada con éxito', solicitud: rows[0] });
    } catch (err) {
        next(err);
    }
});

// 2. LISTAR solicitudes (Solo admin y manager)
// GET /api/solicitudes-autorizacion?estado=pendiente
router.get('/solicitudes-autorizacion', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
    try {
        const estado = req.query.estado || 'pendiente';
        const { rows } = await pool.query(
            `SELECT 
               s.*,
               u_sol.nombre AS solicitante_nombre,
               u_sol.email AS solicitante_email,
               u_aut.nombre AS autorizador_nombre
             FROM public.solicitud_autorizacion s
             JOIN public.usuario u_sol ON u_sol.id_usuario = s.id_usuario_solicitante
             LEFT JOIN public.usuario u_aut ON u_aut.id_usuario = s.id_usuario_autorizador
             WHERE s.estado = $1
             ORDER BY s.fecha_creacion DESC`,
            [estado]
        );
        res.json({ data: rows });
    } catch (err) {
        next(err);
    }
});

// 3. RESPONDER a una solicitud (Aprobar / Rechazar) (Solo admin y manager)
// POST /api/solicitudes-autorizacion/:id/responder
router.post('/solicitudes-autorizacion/:id/responder', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
    const client = await pool.connect();
    try {
        const id_solicitud = parseInt(req.params.id, 10);
        const { estado, comentario_autorizador } = req.body || {};

        if (!['aprobado', 'rechazado'].includes(estado)) {
            return res.status(400).json({ message: 'Estado inválido. Debe ser aprobado o rechazado' });
        }

        const id_autorizador = req.user.id || req.user.sub;

        await client.query('BEGIN');

        // Obtener la solicitud
        const { rows: solRows } = await client.query(
            `SELECT * FROM public.solicitud_autorizacion WHERE id_solicitud = $1 FOR UPDATE`,
            [id_solicitud]
        );

        if (!solRows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Solicitud no encontrada' });
        }

        const solicitud = solRows[0];

        if (solicitud.estado !== 'pendiente') {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'La solicitud ya ha sido resuelta' });
        }

        // Si es aprobada, ejecutamos la acción correspondiente
        if (estado === 'aprobado') {
            if (solicitud.tipo_accion === 'ELIMINAR_PRODUCTO') {
                const { rowCount } = await client.query(
                    `UPDATE public.producto 
                     SET activo = false, 
                         eliminado = true
                     WHERE id_producto = $1 AND eliminado = false`,
                    [solicitud.target_id]
                );
                if (!rowCount) {
                    await client.query('ROLLBACK');
                    return res.status(404).json({ message: 'Producto no encontrado o ya eliminado' });
                }
                // Auditoría de la acción real realizada por el aprobador
                await client.query(
                    `INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
                     VALUES ($1, 'producto', 'PRODUCT_SOFT_DELETE', $2::jsonb, NOW())`,
                    [id_autorizador, JSON.stringify({ id_producto: solicitud.target_id, deleted_product_nombre: solicitud.target_nombre, por_solicitud: id_solicitud })]
                );
            } else if (solicitud.tipo_accion === 'ELIMINAR_VARIANTE') {
                const { rows: stk } = await client.query(`
                  SELECT COALESCE((SELECT SUM(stock) FROM public.inventario WHERE id_variante_producto = $1), 0)::int AS stock
                `, [solicitud.target_id]);
                if (stk.length && stk[0].stock > 0) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ message: 'No se puede aprobar la eliminación: la variante tiene stock > 0' });
                }

                const { rowCount } = await client.query(
                    `UPDATE public.variante_producto 
                     SET eliminado = true, 
                         activo = false 
                     WHERE id_variante_producto = $1 AND eliminado = false`,
                    [solicitud.target_id]
                );
                if (!rowCount) {
                    await client.query('ROLLBACK');
                    return res.status(404).json({ message: 'Variante no encontrada o ya eliminada' });
                }
                // Auditoría de la acción real realizada por el aprobador
                await client.query(
                    `INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
                     VALUES ($1, 'variante_producto', 'VARIANT_DELETE', $2::jsonb, NOW())`,
                    [id_autorizador, JSON.stringify({ id_variante_producto: solicitud.target_id, sku: solicitud.target_nombre, por_solicitud: id_solicitud })]
                );
            } else if (solicitud.tipo_accion === 'REGISTRAR_SALIDA') {
                const payload = typeof solicitud.payload === 'string' ? JSON.parse(solicitud.payload) : (solicitud.payload || {});
                const { cantidades, motivo: movMotivo } = payload || {};
                const entries = Object.entries(cantidades || {});
                
                if (entries.length === 0) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ message: 'No hay cantidades especificadas en la solicitud para registrar la salida' });
                }

                for (const [whId, qty] of entries) {
                    const finalAlmacenId = parseInt(whId, 10);
                    const cant = parseInt(qty, 10);
                    if (isNaN(finalAlmacenId) || isNaN(cant) || cant <= 0) continue;

                    try {
                        await inventarioRouter.aplicarMovimiento({
                            client,
                            idVariante: solicitud.target_id,
                            idAlmacen: finalAlmacenId,
                            tipo: 'salida',
                            cantidad: cant,
                            motivo: movMotivo || solicitud.motivo || 'Salida autorizada por auditoría',
                            refExterna: `SOL-${id_solicitud}`,
                            actorId: id_autorizador
                        });
                    } catch (movErr) {
                        await client.query('ROLLBACK');
                        return res.status(movErr.status || 400).json({ 
                            message: `Error al aplicar salida en almacén #${finalAlmacenId}: ${movErr.message}` 
                        });
                    }
                }
            } else if (solicitud.tipo_accion === 'TRANSFERIR_STOCK') {
                const payload = typeof solicitud.payload === 'string' ? JSON.parse(solicitud.payload) : (solicitud.payload || {});
                const { id_almacen_origen, id_almacen_destino, cantidad, motivo: movMotivo, ref_externa } = payload || {};
                const cant = parseInt(cantidad, 10);
                const originId = parseInt(id_almacen_origen, 10);
                const destId = parseInt(id_almacen_destino, 10);

                if (isNaN(cant) || cant <= 0 || isNaN(originId) || isNaN(destId)) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ message: 'Datos de transferencia inválidos en el payload de la solicitud' });
                }

                try {
                    // 1. Salida de origen
                    await inventarioRouter.aplicarMovimiento({
                        client,
                        idVariante: solicitud.target_id,
                        idAlmacen: originId,
                        tipo: 'salida',
                        cantidad: cant,
                        motivo: movMotivo || solicitud.motivo || `Transferencia (Origen) - Autorizada por auditoría`,
                        refExterna: ref_externa || `SOL-${id_solicitud}`,
                        actorId: id_autorizador
                    });

                    // 2. Entrada a destino
                    await inventarioRouter.aplicarMovimiento({
                        client,
                        idVariante: solicitud.target_id,
                        idAlmacen: destId,
                        tipo: 'entrada',
                        cantidad: cant,
                        motivo: movMotivo || solicitud.motivo || `Transferencia (Destino) - Autorizada por auditoría`,
                        refExterna: ref_externa || `SOL-${id_solicitud}`,
                        actorId: id_autorizador
                    });
                } catch (movErr) {
                    await client.query('ROLLBACK');
                    return res.status(movErr.status || 400).json({ 
                        message: `Error al aplicar transferencia: ${movErr.message}` 
                    });
                }
            } else if (solicitud.tipo_accion === 'ANULAR_VENTA') {
                const payload = typeof solicitud.payload === 'string' ? JSON.parse(solicitud.payload) : (solicitud.payload || {});
                const { descontar_dinero } = payload || {};
                const idPedido = parseInt(solicitud.target_id, 10);

                if (isNaN(idPedido)) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ message: 'ID de pedido inválido en la solicitud' });
                }

                const pedidosRouter = require('./pedidos.routes');
                try {
                    await pedidosRouter.anularPedidoInterno({
                        client,
                        idPedido: idPedido,
                        actorId: id_autorizador,
                        motivo: solicitud.motivo || 'Anulación de venta autorizada por auditoría',
                        descontarDinero: !!descontar_dinero
                    });
                } catch (voidErr) {
                    await client.query('ROLLBACK');
                    return res.status(voidErr.status || 400).json({ 
                        message: `Error al anular pedido #${idPedido}: ${voidErr.message}` 
                    });
                }
            }
        }

        // Actualizar el estado de la solicitud
        const { rows: updatedRows } = await client.query(
            `UPDATE public.solicitud_autorizacion 
             SET estado = $2, 
                 id_usuario_autorizador = $3, 
                 comentario_autorizador = $4, 
                 fecha_resolucion = NOW()
             WHERE id_solicitud = $1
             RETURNING *`,
            [id_solicitud, estado, id_autorizador, comentario_autorizador || null]
        );

        // Registrar la resolución de la solicitud en la auditoría
        await client.query(
            `INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
             VALUES ($1, 'solicitud_autorizacion', 'REQUEST_RESOLVE', $2::jsonb, NOW())`,
            [id_autorizador, JSON.stringify({ id_solicitud, estado, comentario_autorizador })]
        );

        await client.query('COMMIT');
        res.json({ message: `Solicitud ${estado === 'aprobado' ? 'aprobada y ejecutada' : 'rechazada'}`, solicitud: updatedRows[0] });
    } catch (err) {
        await client.query('ROLLBACK');
        next(err);
    } finally {
        client.release();
    }
});

module.exports = router;
