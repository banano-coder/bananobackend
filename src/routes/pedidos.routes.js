// src/routes/pedidos.routes.js
const { Router } = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middlewares/requireAuth');

const router = Router();

// Número de WhatsApp de Banano (env o fallback)
const BANANO_WA = process.env.BANANO_WA || '584129326373';

// Helpers
function toInt(v, def) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : def; }
function toFloat(v, def) { const n = parseFloat(v); return Number.isFinite(n) ? n : def; }
function normEmail(v) {
  const s = String(v || '').trim().toLowerCase();
  return s || null;
}
function normPhone(v) {
  const raw = String(v || '').trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  return digits || null;
}
function normCedula(v) {
  const raw = String(v || '').trim();
  if (!raw) return null;
  const clean = raw.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  return clean || null;
}

/**
 * 0) Buscar datos de cliente por cédula (para auto-relleno en frontend)
 * GET /api/guest/client/:cedula
 */
router.get(['/guest/client/:cedula', '/guest/cliente/:cedula'], async (req, res, next) => {
  try {
    const cedula = normCedula(req.params.cedula);
    if (!cedula) return res.status(400).json({ status: 'error', message: 'cedula es requerida' });

    let { rows } = await pool.query(
      `SELECT cedula, nombre, email, telefono FROM public.cliente WHERE cedula = $1`,
      [cedula]
    );

    // Si es numérico puro y no tiene coincidencia exacta, probar con prefijos de Venezuela
    if (rows.length === 0 && /^\d+$/.test(cedula)) {
      const altRes = await pool.query(
        `SELECT cedula, nombre, email, telefono FROM public.cliente WHERE cedula IN ($1, $2)`,
        [`V${cedula}`, `E${cedula}`]
      );
      if (altRes.rows.length > 0) {
        rows = altRes.rows;
      }
    }

    if (rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'Cliente no encontrado' });
    }

    res.json({ status: 'success', data: rows[0] });
  } catch (err) {
    next(err);
  }
});

async function upsertClienteByCedula(db, { cedula, nombre, email, telefono }) {
  const cedulaNorm = normCedula(cedula);
  const nombreLimpio = String(nombre || '').trim();
  const emailNorm = normEmail(email);
  const telefonoNorm = normPhone(telefono);

  try {
    await db.query(
      `INSERT INTO public.cliente (cedula, nombre, telefono, email)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (cedula)
       DO UPDATE SET
         nombre = EXCLUDED.nombre,
         telefono = EXCLUDED.telefono,
         email = EXCLUDED.email,
         updated_at = NOW()`,
      [cedulaNorm, nombreLimpio, telefonoNorm, emailNorm]
    );
  } catch (e) {
    if (e?.code === '23505') {
      const err = new Error('El teléfono o email ya están registrados en otro cliente');
      err.status = 409;
      throw err;
    }
    throw e;
  }

  return cedulaNorm;
}

// Arma texto de WhatsApp
function buildWaText({ id_pedido, cliente_nombre, cliente_email, cliente_telefono, items, total, nota, welcomeMessage }) {
  const intro = welcomeMessage || '¡Hola! Me interesa este producto de Banano Shop.';
  const header = `Consulta de pedido #${id_pedido}`;
  let cliente = `Nombre: ${cliente_nombre}`;
  if (cliente_email) cliente += `\nEmail: ${cliente_email}`;
  if (cliente_telefono) cliente += `\nTel: ${cliente_telefono}`;

  const lineas = items.map(it => {
    const sku = it.sku ? ` (${it.sku})` : '';
    const subtotal = Number(it.subtotal || (it.precio_unitario * it.cantidad) || 0);
    return `• ${it.nombre_producto}${sku} x${it.cantidad} = $${subtotal.toFixed(2)}`;
  }).join('\n');

  const totalTxt = `Total estimado: $${Number(total || 0).toFixed(2)}`;
  const notaTxt = nota ? `\nNota: ${nota}` : '';

  return [intro, header, cliente, lineas, totalTxt]
    .filter(Boolean)
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .join('\n\n') + notaTxt;
}

// Devuelve link wa.me con ?text=
function buildWaLink(phone, text) {
  const enc = encodeURIComponent(text);
  return `https://wa.me/${phone}?text=${enc}`;
}

/**
 * 1) Checkout invitado (sin login)
 * POST /api/guest/checkout
 * Body:
 * {
 *   "items": [ { "id_variante": 123, "cantidad": 2 }, ... ],
 *   "cliente_nombre": "Isa",
 *   "nota": "entrega hoy",
 *   "cart_token": "uuid-optional"
 * }
 * Calcula precios desde variante_producto.precio_lista,
 * guarda pedido + items (snapshot). No toca inventario.
 * Auditoría: PEDIDO_CREAR (actor_id = NULL porque es invitado).
 */
router.post('/guest/checkout', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { items, cliente_cedula, cedula, cliente_nombre, cliente_email, cliente_telefono, nota } = req.body || {};
    const clienteCedulaNorm = normCedula(cliente_cedula ?? cedula);
    const clienteEmailNorm = normEmail(cliente_email);
    const clienteTelefonoNorm = normPhone(cliente_telefono);

    // Validaciones básicas
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ status: 'error', message: 'items es requerido y no puede estar vacío' });
    }
    if (!cliente_nombre) {
      return res.status(400).json({ status: 'error', message: 'cliente_nombre es requerido' });
    }
    if (!clienteCedulaNorm) {
      return res.status(400).json({ status: 'error', message: 'cliente_cedula es requerido' });
    }
    if (!clienteTelefonoNorm) {
      return res.status(400).json({ status: 'error', message: 'cliente_telefono es requerido' });
    }

    // Normalizar items (admite id_variante_producto | id_variante | id)
    const normItems = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      const rawId = it.id_variante_producto ?? it.id_variante ?? it.id;
      const idVar = Number.parseInt(rawId, 10);
      const qty = Number.parseInt(it.cantidad, 10);
      if (!Number.isInteger(idVar) || idVar <= 0) {
        return res.status(400).json({ status: 'error', message: `Cada item debe tener id_variante válido (ítem ${i + 1})` });
      }
      if (!Number.isInteger(qty) || qty <= 0) {
        return res.status(400).json({ status: 'error', message: `Cantidad inválida para el ítem ${i + 1}` });
      }
      normItems.push({ id_variante_producto: idVar, cantidad: qty });
    }
    const ids = normItems.map(x => x.id_variante_producto);

    // Traer variantes + producto + inventario
    const { rows: variantes } = await pool.query(
      `
      SELECT
        vp.id_variante_producto,
        vp.sku,
        vp.precio_lista::numeric AS precio_lista,
        COALESCE(inv.stock, 0)::int AS stock,
        vp.activo,
        p.nombre AS nombre_producto
      FROM public.variante_producto vp
      JOIN public.producto p
        ON p.id_producto = vp.id_producto
      LEFT JOIN public.inventario inv
        ON inv.id_variante_producto = vp.id_variante_producto
      WHERE vp.id_variante_producto = ANY($1::int[])
      `,
      [ids]
    );
    const mapVar = new Map(variantes.map(v => [Number(v.id_variante_producto), v]));

    // Validaciones de negocio
    for (const it of normItems) {
      const v = mapVar.get(Number(it.id_variante_producto));
      if (!v) return res.status(400).json({ status: 'error', message: `Variante ${it.id_variante_producto} no existe` });
      if (v.activo === false) return res.status(400).json({ status: 'error', message: `Variante ${it.id_variante_producto} inactiva` });
      if (v.stock < it.cantidad) return res.status(400).json({ status: 'error', message: `Stock insuficiente en variante ${it.id_variante_producto} (disp: ${v.stock})` });
      if (v.precio_lista == null) return res.status(500).json({ status: 'error', message: `Variante ${it.id_variante_producto} no tiene precio_lista` });
    }

    await client.query('BEGIN');

    const cedulaCliente = await upsertClienteByCedula(client, {
      cedula: clienteCedulaNorm,
      nombre: cliente_nombre,
      email: clienteEmailNorm,
      telefono: cliente_telefono
    });

    // Crear pedido con email y teléfono
    const { rows: ped } = await client.query(
      `INSERT INTO public.pedido (cedula_cliente, cliente_nombre, cliente_email, cliente_telefono, observacion, estado)
       VALUES ($1, $2, $3, $4, $5, 'nuevo') RETURNING id_pedido`,
      [cedulaCliente, cliente_nombre, clienteEmailNorm, clienteTelefonoNorm, nota || null]
    );
    const id_pedido = ped[0].id_pedido;

    // Insertar items y calcular total
    let total = 0;
    const snapshotItems = [];
    for (const it of normItems) {
      const v = mapVar.get(Number(it.id_variante_producto));
      const unit = Number(v.precio_lista);
      const sub = +(unit * it.cantidad).toFixed(2);

      await client.query(
        `INSERT INTO public.pedido_item (id_pedido, id_variante_producto, nombre_producto, sku, cantidad, precio_unitario, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id_pedido, v.id_variante_producto, v.nombre_producto, v.sku, it.cantidad, unit, sub]
      );
      total += sub;

      snapshotItems.push({
        id_variante: v.id_variante_producto,
        nombre_producto: v.nombre_producto,
        sku: v.sku,
        precio_unitario: unit,
        cantidad: it.cantidad,
        subtotal: sub
      });
    }

    // Auditoría
    await client.query(
      `INSERT INTO public.auditoria (actor_id, target_pedido_id, target_tipo, action, payload, created_at)
       VALUES ($1, $2, 'pedido', 'PEDIDO_CREAR', $3::jsonb, NOW())`,
      [null, id_pedido, JSON.stringify({ cedula_cliente: cedulaCliente, cliente_nombre, cliente_email: clienteEmailNorm, cliente_telefono: clienteTelefonoNorm, total, items: normItems })]
    );

    // Obtener configuración de WhatsApp dinámica
    const { rows: waConfig } = await client.query('SELECT valor FROM public.configuracion WHERE clave = $1', ['whatsapp']);
    const waData = waConfig[0]?.valor || {};
    const targetPhone = waData.numero || BANANO_WA;
    const welcomeMsg = waData.mensaje_bienvenida;

    // Generar mensaje y link WA
    const texto = buildWaText({
      id_pedido,
      cliente_nombre,
      cliente_email: clienteEmailNorm,
      cliente_telefono: clienteTelefonoNorm,
      items: snapshotItems,
      total,
      nota,
      welcomeMessage: welcomeMsg
    });
    const waUrl = buildWaLink(targetPhone, texto);

    // Guardar snapshot WA y total_estimado (importante para el dashboard)
    await client.query(
      `UPDATE public.pedido
         SET whatsapp_text = $2, whatsapp_link = $3, total_estimado = $4, updated_at = NOW()
       WHERE id_pedido = $1`,
      [id_pedido, texto, waUrl, total]
    );

    await client.query('COMMIT');
    return res.status(201).json({ id_pedido, waUrl });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { }
    next(err);
  } finally {
    client.release();
  }
});

/**
 * 1.5) POS Checkout (authenticated cashier)
 * POST /api/pos/checkout
 * Body:
 * {
 *   "items": [ { "id_variante_producto": 123, "cantidad": 2 }, ... ],
 *   "cliente_cedula": "V12345678",
 *   "cliente_nombre": "Carlos Perez",
 *   "cliente_email": "carlos@gmail.com",
 *   "cliente_telefono": "04123456789",
 *   "nota": "Venta POS",
 *   "id_cuenta": 1,
 *   "moneda_pago": "USD",
 *   "tasa_cambio": 1.0,
 *   "monto_pago_real": 150.00
 * }
 */
router.post('/pos/checkout', requireAuth, requireRole('admin', 'manager', 'vendedor'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const {
      items,
      cliente_cedula,
      cliente_nombre,
      cliente_email,
      cliente_telefono,
      nota,
      id_cuenta,
      moneda_pago,
      tasa_cambio,
      monto_pago_real,
      pagos
    } = req.body || {};

    // 1. Validaciones básicas
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ status: 'error', message: 'items es requerido y no puede estar vacío' });
    }
    if (!cliente_cedula || !cliente_nombre) {
      return res.status(400).json({ status: 'error', message: 'cliente_cedula y cliente_nombre son requeridos' });
    }

    // Normalizar la lista de pagos
    let paymentsList = [];
    if (Array.isArray(pagos) && pagos.length > 0) {
      paymentsList = pagos.map((p, idx) => {
        if (!p.id_cuenta) {
          const err = new Error(`El pago en el índice ${idx} no tiene id_cuenta`);
          err.status = 400;
          throw err;
        }
        return {
          id_cuenta: parseInt(p.id_cuenta, 10),
          moneda_pago: p.moneda_pago || 'USD',
          tasa_cambio: p.tasa_cambio ? parseFloat(p.tasa_cambio) : 1.0,
          monto_real: p.monto_real ? parseFloat(p.monto_real) : 0.0,
          monto_usd: p.monto_usd ? parseFloat(p.monto_usd) : 0.0,
          metodo: p.metodo || 'Efectivo',
          referencia: p.referencia || ''
        };
      });
    } else {
      if (!id_cuenta) {
        return res.status(400).json({ status: 'error', message: 'id_cuenta o pagos es requerido' });
      }
      paymentsList = [{
        id_cuenta: parseInt(id_cuenta, 10),
        moneda_pago: moneda_pago || 'USD',
        tasa_cambio: tasa_cambio ? parseFloat(tasa_cambio) : 1.0,
        monto_real: monto_pago_real ? parseFloat(monto_pago_real) : 0.0,
        monto_usd: 0.0, // Se calculará después de saber el total de la venta
        metodo: req.body.metodo || 'Efectivo',
        referencia: req.body.referencia || ''
      }];
    }

    // Resolver sucursal y usuario
    const idUsuario = req.user.id || req.user.sub;
    const idAlmacen = req.body.id_almacen ? parseInt(req.body.id_almacen, 10) : (req.user.id_almacen ? parseInt(req.user.id_almacen, 10) : 1);

    // Normalizar items
    const normItems = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      const rawId = it.id_variante_producto ?? it.id_variante ?? it.id;
      const idVar = Number.parseInt(rawId, 10);
      const qty = Number.parseInt(it.cantidad, 10);
      if (!Number.isInteger(idVar) || idVar <= 0) {
        return res.status(400).json({ status: 'error', message: `Cada item debe tener id_variante_producto válido (ítem ${i + 1})` });
      }
      if (!Number.isInteger(qty) || qty <= 0) {
        return res.status(400).json({ status: 'error', message: `Cantidad inválida para el ítem ${i + 1}` });
      }
      normItems.push({ id_variante_producto: idVar, cantidad: qty });
    }
    const ids = normItems.map(x => x.id_variante_producto);

    // Traer variantes
    const { rows: variantes } = await pool.query(
      `
      SELECT
        vp.id_variante_producto,
        vp.sku,
        vp.precio_lista::numeric AS precio_lista,
        vp.activo,
        p.nombre AS nombre_producto
      FROM public.variante_producto vp
      JOIN public.producto p ON p.id_producto = vp.id_producto
      WHERE vp.id_variante_producto = ANY($1::int[])
      `,
      [ids]
    );
    const mapVar = new Map(variantes.map(v => [Number(v.id_variante_producto), v]));

    for (const it of normItems) {
      const v = mapVar.get(Number(it.id_variante_producto));
      if (!v) return res.status(400).json({ status: 'error', message: `Variante ${it.id_variante_producto} no existe` });
      if (v.activo === false) return res.status(400).json({ status: 'error', message: `Variante ${it.id_variante_producto} inactiva` });
    }

    await client.query('BEGIN');

    // 2. Upsert cliente
    const clienteCedulaNorm = await upsertClienteByCedula(client, {
      cedula: cliente_cedula,
      nombre: cliente_nombre,
      email: cliente_email || null,
      telefono: cliente_telefono || null
    });

    // 3. Obtener y bloquear todas las cuentas de dinero involucradas
    // Filtramos los pagos que ya tienen id_cuenta (efectivo sin cuenta se resuelve después)
    const cuentaIdsIniciales = [...new Set(paymentsList.filter(p => p.id_cuenta).map(p => p.id_cuenta))].sort((a, b) => a - b);

    // Verificar si la columna es_efectivo ya existe en BD
    const { rows: colCheckPed } = await client.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'cuenta' AND column_name = 'es_efectivo'
    `);
    const hasEsEfectivoPed = colCheckPed.length > 0;

    const { rows: cRows } = await client.query(
      `SELECT id_cuenta, nombre, moneda, saldo::float AS saldo, activo, eliminado,
              es_cashea::boolean AS es_cashea,
              ${hasEsEfectivoPed ? 'es_efectivo::boolean AS es_efectivo' : 'false AS es_efectivo'}
       FROM public.cuenta
       WHERE id_cuenta = ANY($1::int[]) AND eliminado = false
       FOR UPDATE`,
      [cuentaIdsIniciales]
    );

    const cuentaMap = new Map(cRows.map(c => [c.id_cuenta, c]));
    for (const p of paymentsList) {
      if (!p.id_cuenta) continue; // se resuelve abajo para efectivo sin cuenta
      const cuenta = cuentaMap.get(p.id_cuenta);
      if (!cuenta) {
        await client.query('ROLLBACK');
        return res.status(404).json({ status: 'error', message: `Cuenta bancaria/caja ID ${p.id_cuenta} no encontrada` });
      }
      if (!cuenta.activo) {
        await client.query('ROLLBACK');
        return res.status(400).json({ status: 'error', message: `La cuenta "${cuenta.nombre}" está desactivada` });
      }
    }

    // 3.5 Resolver cuenta de efectivo de la sede para pagos en efectivo sin cuenta asignada
    // Si el pago tiene metodo 'Efectivo' y no tiene id_cuenta, se busca la caja efectivo del almacén
    for (let i = 0; i < paymentsList.length; i++) {
      const p = paymentsList[i];
      const esEfectivo = (p.metodo || '').toLowerCase() === 'efectivo';
      if (esEfectivo && (!p.id_cuenta || p.id_cuenta === 0)) {
        if (!hasEsEfectivoPed) {
          // La columna aún no existe: no podemos auto-resolver. Requerir id_cuenta explícito.
          await client.query('ROLLBACK');
          return res.status(400).json({
            status: 'error',
            message: `Ejecute la migración SQL (ALTER TABLE cuenta ADD COLUMN es_efectivo) para habilitar la asignación automática de caja por sede. Por ahora, seleccione la cuenta de destino manualmente.`
          });
        }
        const { rows: efectivoRows } = await client.query(
          `SELECT id_cuenta, nombre, moneda, saldo::float AS saldo, activo, es_cashea, es_efectivo
           FROM public.cuenta
           WHERE es_efectivo = true AND id_almacen = $1 AND eliminado = false AND activo = true
           LIMIT 1
           FOR UPDATE`,
          [idAlmacen]
        );
        if (!efectivoRows.length) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            status: 'error',
            message: `No hay caja de efectivo configurada para la sede/almacén #${idAlmacen}. Configure una cuenta con "Caja Efectivo" marcada para este almacén.`
          });
        }
        const cuentaEfectivo = efectivoRows[0];
        paymentsList[i].id_cuenta = cuentaEfectivo.id_cuenta;
        if (!cuentaMap.has(cuentaEfectivo.id_cuenta)) {
          cuentaMap.set(cuentaEfectivo.id_cuenta, cuentaEfectivo);
        }
      }
    }

    // 3.6 Leer porcentaje de incremento (aplica siempre que haya pagos Cashea, en Bs o USD)
    const casheaCuentaIds = new Set([...cuentaMap.values()].filter(c => c.es_cashea).map(c => c.id_cuenta));
    const hayCashea = paymentsList.some(p => casheaCuentaIds.has(p.id_cuenta));

    let incrementoPct = 0;
    if (hayCashea) {
      const { rows: configRows } = await client.query("SELECT valor FROM public.configuracion WHERE clave = 'catalogo'");
      const catalogoConfig = configRows[0]?.valor || {};
      incrementoPct = parseFloat(catalogoConfig.porcentaje_incremento_bcv || 0);
    }
    const incrementoFactor = 1 + (incrementoPct / 100);

    // Calcular el total base de la venta (en USD, precio lista sin incremento)
    let preTotalBase = 0;
    const itemsWithPrices = normItems.map(it => {
      const v = mapVar.get(Number(it.id_variante_producto));
      const unit = Number(v.precio_lista || 0);
      const sub = +(unit * it.cantidad).toFixed(2);
      preTotalBase += sub;
      return { ...it, unit, sub, nombre_producto: v.nombre_producto, sku: v.sku };
    });

    // Para pagos sin lista dividida (fallback un solo pago)
    if (!pagos || pagos.length === 0) {
      paymentsList[0].monto_usd = preTotalBase;
      if (!paymentsList[0].monto_real) {
        paymentsList[0].monto_real = +(preTotalBase * paymentsList[0].tasa_cambio).toFixed(2);
      }
    }

    // Monto Cashea base (sin incremento) para calcular ratio y comisión
    const totalCasheaBaseUsd = paymentsList
      .filter(p => casheaCuentaIds.has(p.id_cuenta))
      .reduce((sum, p) => sum + p.monto_usd, 0);

    // Monto Cashea con incremento (precio real que entra en la caja Cashea)
    const totalCasheaInfladoUsd = +(totalCasheaBaseUsd * incrementoFactor).toFixed(2);

    // Comisión Cashea 4% sobre el monto inflado
    const comisionTotalCasheaUsd = totalCasheaInfladoUsd > 0
      ? +(totalCasheaInfladoUsd * 0.04).toFixed(2)
      : 0;

    // Ratio de Cashea sobre el total base (para distribuir comisión por item)
    const ratioCashea = preTotalBase > 0 ? (totalCasheaBaseUsd / preTotalBase) : 0;

    // Total del pedido = base de no-Cashea + inflado de Cashea
    const totalBaseNoCashea = preTotalBase - totalCasheaBaseUsd;
    const totalPedido = +(totalBaseNoCashea + totalCasheaInfladoUsd).toFixed(2);

    // 4. Crear el pedido
    const firstPayment = paymentsList[0];
    const { rows: ped } = await client.query(
      `INSERT INTO public.pedido (
        cedula_cliente, cliente_nombre, cliente_email, cliente_telefono,
        observacion, estado, origen, id_almacen, id_usuario, id_cuenta,
        moneda_pago, tasa_cambio, monto_pago_real, comision_total_cashea
       ) VALUES ($1, $2, $3, $4, $5, 'concretado', 'pos', $6, $7, $8, $9, $10, $11, $12)
       RETURNING id_pedido`,
      [
        clienteCedulaNorm,
        cliente_nombre,
        cliente_email || null,
        cliente_telefono || null,
        nota || 'Venta POS',
        idAlmacen,
        idUsuario,
        firstPayment.id_cuenta,
        firstPayment.moneda_pago,
        firstPayment.tasa_cambio,
        firstPayment.monto_real,
        comisionTotalCasheaUsd
      ]
    );
    const id_pedido = ped[0].id_pedido;

    // 5. Insertar items (subtotal refleja el precio inflado proporcional a la porción Cashea)
    const { aplicarMovimiento } = require('./inventario.routes');
    let total = 0;

    for (const it of itemsWithPrices) {
      // El subtotal por item: la porción Cashea lleva el incremento, la no-Cashea queda a precio base
      const subInflado = +(it.sub * (1 + ratioCashea * (incrementoFactor - 1))).toFixed(2);
      const comisionItem = +(subInflado * ratioCashea * 0.04).toFixed(2);

      await client.query(
        `INSERT INTO public.pedido_item (id_pedido, id_variante_producto, nombre_producto, sku, cantidad, precio_unitario, subtotal, comision_cashea)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id_pedido, it.id_variante_producto, it.nombre_producto, it.sku, it.cantidad, it.unit, subInflado, comisionItem]
      );
      total += subInflado;

      await aplicarMovimiento({
        client,
        idVariante: it.id_variante_producto,
        idAlmacen: idAlmacen,
        tipo: 'salida',
        cantidad: it.cantidad,
        motivo: `Venta POS Pedido #${id_pedido}`,
        refExterna: `PED-${id_pedido}`,
        costoUnitario: null,
        actorId: idUsuario
      });
    }

    // Actualizar total_estimado con el precio inflado
    await client.query(
      `UPDATE public.pedido SET total_estimado = $2 WHERE id_pedido = $1`,
      [id_pedido, total]
    );

    // Actualizar montos de los pagos Cashea: aplicar incremento al monto_usd y monto_real
    for (const p of paymentsList) {
      if (casheaCuentaIds.has(p.id_cuenta)) {
        p.monto_usd = +(p.monto_usd * incrementoFactor).toFixed(2);
        p.monto_real = +(p.monto_real * incrementoFactor).toFixed(2);
      }
    }

    // Validar que la suma de pagos coincida con el total inflado (solo en modo pagos divididos)
    if (pagos && pagos.length > 0) {
      const totalPagadoUsd = paymentsList.reduce((sum, p) => sum + p.monto_usd, 0);
      if (Math.abs(totalPagadoUsd - total) >= 0.02) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          status: 'error',
          message: `El monto total pagado ($${totalPagadoUsd.toFixed(2)}) no coincide con el total de la venta ($${total.toFixed(2)})`
        });
      }
    } else {
      await client.query(
        `UPDATE public.pedido SET monto_pago_real = $2 WHERE id_pedido = $1`,
        [id_pedido, paymentsList[0].monto_real]
      );
    }

    // 6 & 7. Registrar transacciones de caja y actualizar saldos
    for (const p of paymentsList) {
      const cuenta = cuentaMap.get(p.id_cuenta);
      const isCashea = cuenta.es_cashea;
      // La comisión se calcula sobre el monto inflado ya actualizado en p.monto_usd
      const comisionUsd = isCashea ? +(p.monto_usd * 0.04).toFixed(2) : 0.00;
      const comisionReal = isCashea ? +(p.monto_real * 0.04).toFixed(2) : 0.00;
      const refText = p.referencia ? ` (Ref: ${p.referencia})` : '';
      const metodoText = p.metodo ? ` - ${p.metodo}` : '';
      const concepto = `Venta POS Pedido #${id_pedido}${metodoText}${refText}`;

      // Registrar con el monto inflado para Cashea (el precio full entra al registro)
      await client.query(
        `INSERT INTO public.transaccion_caja (id_cuenta, tipo, monto_usd, tasa_cambio, monto_real, concepto, id_pedido, id_usuario, comision_usd, comision_real, liquidado)
         VALUES ($1, 'ingreso', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          p.id_cuenta,
          p.monto_usd,
          p.tasa_cambio,
          p.monto_real,
          concepto,
          id_pedido,
          idUsuario,
          comisionUsd,
          comisionReal,
          isCashea ? false : true
        ]
      );

      const nuevoSaldo = +(cuenta.saldo + p.monto_real).toFixed(2);
      await client.query(
        `UPDATE public.cuenta SET saldo = $2, updated_at = NOW() WHERE id_cuenta = $1`,
        [p.id_cuenta, nuevoSaldo]
      );
      cuenta.saldo = nuevoSaldo;
    }

    // 8. Auditoría
    await client.query(
      `INSERT INTO public.auditoria (actor_id, target_pedido_id, target_tipo, action, payload, created_at)
       VALUES ($1, $2, 'pedido', 'PEDIDO_CREAR', $3::jsonb, NOW())`,
      [
        idUsuario,
        id_pedido,
        JSON.stringify({
          cedula_cliente: clienteCedulaNorm,
          cliente_nombre,
          total,
          incrementoPct,
          items: normItems,
          pagos: paymentsList,
          id_almacen: idAlmacen
        })
      ]
    );

    await client.query('COMMIT');
    res.status(201).json({ status: 'success', id_pedido });

  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { }
    if (err.status) return res.status(err.status).json({ status: 'error', message: err.message });
    next(err);
  } finally {
    client.release();
  }
});

/**
 * 2) Listado (admin/manager)
 * GET /api/pedidos?estado=&from=&to=&search=&page=1&limit=20
 * (search solo por nombre ahora)
 */
router.get('/pedidos', requireAuth, requireRole('admin', 'manager', 'vendedor'), async (req, res, next) => {
  try {
    const estado = (req.query.estado || '').trim();
    const from = (req.query.from || '').trim();
    const to = (req.query.to || '').trim();
    const search = (req.query.search || '').trim();
    const id_almacen = toInt(req.query.id_almacen, null);
    const page = Math.max(1, toInt(req.query.page, 1));
    const limit = Math.min(100, Math.max(1, toInt(req.query.limit, 20)));
    const offset = (page - 1) * limit;

    const conds = [];
    const params = [];
    let i = 1;

    if (estado) { conds.push(`p.estado = $${i++}`); params.push(estado); }
    if (from) { conds.push(`p.created_at >= $${i++}::timestamptz`); params.push(from); }
    if (to) { conds.push(`p.created_at <  ($${i++}::timestamptz + INTERVAL '1 day')`); params.push(to); }
    if (search) {
      conds.push(`(p.cliente_nombre ILIKE $${i})`);
      params.push(`%${search}%`); i++;
    }

    // Restricción por sucursal: Vendedor solo ve pedidos de su almacén. Admin/manager filtra opcionalmente.
    const roles = req.user?.roles || [];
    const isVendor = roles.includes('vendedor') && !roles.some(r => r === 'admin' || r === 'manager');
    if (isVendor && req.user?.id_almacen) {
      conds.push(`p.id_almacen = $${i++}`);
      params.push(req.user.id_almacen);
    } else if (id_almacen) {
      conds.push(`p.id_almacen = $${i++}`);
      params.push(id_almacen);
    }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const allowedSort = new Set(['created_at', 'estado', 'total']);
    const sort = allowedSort.has((req.query.sort || '').toLowerCase()) ? req.query.sort.toLowerCase() : 'created_at';
    const dir = (req.query.dir || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
    const sortCol = sort === 'total' ? 'p.total_estimado' : sort === 'estado' ? 'p.estado' : 'p.created_at';


    const { rows: t } = await pool.query(`SELECT COUNT(*)::int AS total FROM public.pedido p ${where}`, params);
    const total = t[0].total;

    const { rows: data } = await pool.query(
      `
      SELECT p.id_pedido, p.cedula_cliente, p.origen, p.cliente_nombre, p.cliente_email, p.cliente_telefono,
             p.total_estimado::float AS total_estimado, p.estado, p.created_at, p.updated_at,
             p.id_almacen, alm.nombre AS almacen_nombre,
             p.moneda_pago, p.tasa_cambio::float AS tasa_cambio, p.monto_pago_real::float AS monto_pago_real
      FROM public.pedido p
      LEFT JOIN public.almacen alm ON alm.id_almacen = p.id_almacen
      ${where}
      ORDER BY ${sortCol} ${dir}
      LIMIT ${limit} OFFSET ${offset}
      `,
      params
    );

    res.json({ data, page, limit, total });
  } catch (err) {
    next(err);
  }
});

/** 3) Detalle (admin/manager o vendedor) */
router.get('/pedidos/:id', requireAuth, requireRole('admin', 'manager', 'vendedor'), async (req, res, next) => {
  try {
    const id = toInt(req.params.id, 0);
    if (!id) return res.status(400).json({ message: 'id inválido' });

    const { rows: head } = await pool.query(
      `
      SELECT p.id_pedido, p.cedula_cliente, p.origen, p.cliente_nombre, p.cliente_email, p.cliente_telefono,
             p.total_estimado::float AS total_estimado, p.estado, p.whatsapp_text, p.whatsapp_link,
             p.observacion, p.created_at, p.updated_at,
             p.id_almacen, alm.nombre AS almacen_nombre,
             p.id_cuenta, cta.nombre AS cuenta_nombre,
             p.id_usuario, usr.nombre AS vendedor_nombre,
             p.moneda_pago, p.tasa_cambio::float AS tasa_cambio, p.monto_pago_real::float AS monto_pago_real
      FROM public.pedido p
      LEFT JOIN public.almacen alm ON alm.id_almacen = p.id_almacen
      LEFT JOIN public.cuenta cta ON cta.id_cuenta = p.id_cuenta
      LEFT JOIN public.usuario usr ON usr.id_usuario = p.id_usuario
      WHERE p.id_pedido = $1
      `,
      [id]
    );
    if (!head.length) return res.status(404).json({ message: 'Pedido no encontrado' });

    const roles = req.user?.roles || [];
    const isVendor = roles.includes('vendedor') && !roles.some(r => r === 'admin' || r === 'manager');
    if (isVendor && req.user?.id_almacen && head[0].id_almacen && head[0].id_almacen !== req.user.id_almacen) {
      return res.status(403).json({ message: 'No autorizado para ver pedidos de otra sucursal' });
    }

    const { rows: items } = await pool.query(
      `
      SELECT pi.id_pedido_item, pi.id_variante_producto, pi.nombre_producto, pi.sku,
             pi.precio_unitario::float AS precio_unitario, pi.cantidad, pi.subtotal::float AS subtotal,
             COALESCE(v.costo, 0)::float AS costo_unitario
      FROM public.pedido_item pi
      LEFT JOIN public.variante_producto v ON v.id_variante_producto = pi.id_variante_producto
      WHERE pi.id_pedido = $1 
      ORDER BY pi.id_pedido_item
      `,
      [id]
    );

    const { rows: transacciones } = await pool.query(
      `
      SELECT t.id_transaccion, t.id_cuenta, c.nombre AS cuenta_nombre, c.moneda AS cuenta_moneda,
             t.tipo, t.monto_usd::float AS monto_usd, t.tasa_cambio::float AS tasa_cambio, 
             t.monto_real::float AS monto_real, t.concepto
      FROM public.transaccion_caja t
      JOIN public.cuenta c ON c.id_cuenta = t.id_cuenta
      WHERE t.id_pedido = $1
      `,
      [id]
    );

    res.json({ ...head[0], items, transacciones });
  } catch (err) { next(err); }
});

/**
 * 4) Cambiar estado (admin/manager o vendedor)
 * PATCH /api/pedidos/:id/estado
 * Body: { "estado": "contactado|concretado|cancelado" }
 * Auditoría: PEDIDO_CAMBIAR_ESTADO
 */
router.patch('/pedidos/:id/estado', requireAuth, requireRole('admin', 'manager', 'vendedor'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = toInt(req.params.id, 0);
    const estado = String(req.body?.estado || '').trim();
    const valid = new Set(['nuevo', 'contactado', 'concretado', 'cancelado']);
    if (!id) return res.status(400).json({ message: 'id inválido' });
    if (!valid.has(estado)) return res.status(400).json({ message: 'estado inválido' });

    await client.query('BEGIN');

    const { rowCount } = await client.query(
      `UPDATE public.pedido SET estado = $2, updated_at = NOW() WHERE id_pedido = $1`,
      [id, estado]
    );
    if (!rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Pedido no encontrado' });
    }

    await client.query(
      `INSERT INTO public.auditoria (actor_id, target_pedido_id, target_tipo, action, payload, created_at)
       VALUES ($1, $2, 'pedido', 'PEDIDO_CAMBIAR_ESTADO', $3::jsonb, NOW())`,
      [req.user.id || req.user.sub, id, JSON.stringify({ estado })]
    );

    await client.query('COMMIT');
    res.json({ message: 'Estado actualizado', estado });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { }
    next(err);
  } finally {
    client.release();
  }
});

/**
 * 5) Anular pedido (admin/manager)
 * POST /api/pedidos/:id/anular
 * Body: { "motivo": "...", "descontar_dinero": true|false }
 */
router.post('/pedidos/:id/anular', requireAuth, requireRole('admin', 'manager'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = toInt(req.params.id, 0);
    const { motivo, descontar_dinero } = req.body || {};
    
    if (!id) return res.status(400).json({ message: 'id inválido' });
    if (!motivo || !String(motivo).trim()) {
      return res.status(400).json({ message: 'El motivo de la anulación es requerido' });
    }

    await client.query('BEGIN');

    await anularPedidoInterno({
      client,
      idPedido: id,
      actorId: req.user.id || req.user.sub,
      motivo: String(motivo).trim(),
      descontarDinero: !!descontar_dinero
    });

    await client.query('COMMIT');
    res.json({ message: 'Pedido anulado con éxito' });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { }
    if (err.status) return res.status(err.status).json({ message: err.message });
    next(err);
  } finally {
    client.release();
  }
});

async function anularPedidoInterno({ client, idPedido, actorId, motivo, descontarDinero }) {
  // 1. Obtener y bloquear el pedido
  const { rows: pedRows } = await client.query(
    `SELECT id_pedido, estado, id_almacen FROM public.pedido WHERE id_pedido = $1 FOR UPDATE`,
    [idPedido]
  );
  if (!pedRows.length) {
    const err = new Error('Pedido no encontrado');
    err.status = 404;
    throw err;
  }
  const pedido = pedRows[0];
  if (pedido.estado === 'anulado') {
    const err = new Error('El pedido ya está anulado');
    err.status = 400;
    throw err;
  }

  // 2. Revertir Stock
  const { rows: items } = await client.query(
    `SELECT id_variante_producto, cantidad FROM public.pedido_item WHERE id_pedido = $1`,
    [idPedido]
  );

  const { aplicarMovimiento } = require('./inventario.routes');
  for (const item of items) {
    await aplicarMovimiento({
      client,
      idVariante: item.id_variante_producto,
      idAlmacen: pedido.id_almacen || 1,
      tipo: 'entrada',
      cantidad: item.cantidad,
      motivo: `Venta anulada (Pedido #${idPedido}): ${motivo}`,
      refExterna: `ANUL-PED-${idPedido}`,
      actorId: actorId
    });
  }

  // 3. Descontar Dinero si corresponde
  if (descontarDinero) {
    const { rows: transacciones } = await client.query(
      `SELECT id_transaccion, id_cuenta, monto_usd, tasa_cambio, monto_real 
       FROM public.transaccion_caja 
       WHERE id_pedido = $1 AND tipo = 'ingreso'`,
      [idPedido]
    );

    for (const t of transacciones) {
      const { rows: cRows } = await client.query(
        `SELECT id_cuenta, saldo::float AS saldo, nombre 
         FROM public.cuenta 
         WHERE id_cuenta = $1 AND eliminado = false 
         FOR UPDATE`,
        [t.id_cuenta]
      );
      if (!cRows.length) {
        const err = new Error(`Cuenta bancaria/caja ID ${t.id_cuenta} no encontrada para devolución`);
        err.status = 404;
        throw err;
      }
      const cuenta = cRows[0];
      const nuevoSaldo = +(cuenta.saldo - t.monto_real).toFixed(2);
      await client.query(
        `UPDATE public.cuenta SET saldo = $2, updated_at = NOW() WHERE id_cuenta = $1`,
        [t.id_cuenta, nuevoSaldo]
      );

      await client.query(
        `INSERT INTO public.transaccion_caja (id_cuenta, tipo, monto_usd, tasa_cambio, monto_real, concepto, id_pedido, id_usuario)
         VALUES ($1, 'egreso', $2, $3, $4, $5, $6, $7)`,
        [
          t.id_cuenta,
          t.monto_usd,
          t.tasa_cambio,
          t.monto_real,
          `Devolución Venta Anulada Pedido #${idPedido}: ${motivo}`,
          idPedido,
          actorId
        ]
      );
    }
  }

  // 4. Cambiar estado
  await client.query(
    `UPDATE public.pedido SET estado = 'anulado', updated_at = NOW() WHERE id_pedido = $1`,
    [idPedido]
  );

  // 5. Registrar Auditoría
  await client.query(
    `INSERT INTO public.auditoria (actor_id, target_pedido_id, target_tipo, action, payload, created_at)
     VALUES ($1, $2, 'pedido', 'PEDIDO_ANULAR', $3::jsonb, NOW())`,
    [
      actorId,
      idPedido,
      JSON.stringify({ motivo, descontar_dinero: descontarDinero })
    ]
  );
}

router.anularPedidoInterno = anularPedidoInterno;

module.exports = router;
