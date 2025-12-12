const { Router } = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middlewares/requireAuth');

const router = Router();

// LIST (todos los roles ven)
router.get('/categories', requireAuth, requireRole('admin','manager','vendedor','viewer'), async (req,res,next)=>{
  try{
    const { rows } = await pool.query(`
      SELECT id_categoria, nombre, id_padre, activo
      FROM public.categoria
      ORDER BY nombre
    `);
    res.json({ data: rows });
  }catch(err){ next(err); }
});

// CREATE (admin/manager)
router.post('/categories', requireAuth, requireRole('admin','manager'), async (req,res,next)=>{
  const client = await pool.connect();
  try{
    const { nombre, id_padre, activo=true } = req.body || {};
    if(!nombre) return res.status(400).json({message:'nombre requerido'});

    await client.query('BEGIN');

    if (id_padre) {
      const { rows: exists } = await client.query(
        `SELECT 1 FROM public.categoria WHERE id_categoria=$1`, [id_padre]
      );
      if(!exists.length){ await client.query('ROLLBACK'); return res.status(400).json({message:'id_padre no existe'}); }
    }

    const { rows } = await client.query(`
      INSERT INTO public.categoria (nombre, id_padre, activo)
      VALUES ($1,$2,$3)
      RETURNING id_categoria, nombre, id_padre, activo
    `,[nombre, id_padre || null, Boolean(activo)]);

    await client.query(`
      INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
      VALUES ($1, 'categoria', 'CAT_CREATE', $2::jsonb, NOW())
    `,[req.user.id || req.user.sub, JSON.stringify({ id_categoria: rows[0].id_categoria, nombre, id_padre })]);

    await client.query('COMMIT');
    res.status(201).json({ message:'Categoria creada', category: rows[0] });
  }catch(err){ try{await pool.query('ROLLBACK')}catch{}; next(err); }
  finally{ client.release(); }
});

// UPDATE (admin/manager)
router.patch('/categories/:id', requireAuth, requireRole('admin','manager'), async (req,res,next)=>{
  const client = await pool.connect();
  try{
    const id = parseInt(req.params.id,10);
    const { nombre, id_padre, activo } = req.body || {};
    if(!id) return res.status(400).json({message:'id inválido'});

    await client.query('BEGIN');

    if(id_padre){
      if(id_padre === id){ await client.query('ROLLBACK'); return res.status(400).json({message:'id_padre no puede ser igual al id'}); }
      const { rows: ex } = await client.query(`SELECT 1 FROM public.categoria WHERE id_categoria=$1`,[id_padre]);
      if(!ex.length){ await client.query('ROLLBACK'); return res.status(400).json({message:'id_padre no existe'}); }
    }

    const { rowCount, rows } = await client.query(`
      UPDATE public.categoria
      SET nombre = COALESCE($2, nombre),
          id_padre = $3,
          activo = COALESCE($4, activo)
      WHERE id_categoria = $1
      RETURNING id_categoria, nombre, id_padre, activo
    `,[id, nombre ?? null, (id_padre===undefined)? undefined : (id_padre||null), (activo===undefined)? undefined : Boolean(activo)]);
    if(!rowCount){ await client.query('ROLLBACK'); return res.status(404).json({message:'No encontrada'}); }

    await client.query(`
      INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
      VALUES ($1, 'categoria', 'CAT_UPDATE', $2::jsonb, NOW())
    `,[req.user.id || req.user.sub, JSON.stringify({ id_categoria: id, changes: (req.body||{}) })]);

    await client.query('COMMIT');
    res.json({ message:'Actualizada', category: rows[0] });
  }catch(err){ try{await pool.query('ROLLBACK')}catch{}; next(err); }
  finally{ client.release(); }
});

// DELETE lógico con validación (admin/manager)
router.delete('/categories/:id', requireAuth, requireRole('admin','manager'), async (req,res,next)=>{
  const client = await pool.connect();
  try{
    const id = parseInt(req.params.id,10);
    if(!id) return res.status(400).json({message:'id inválido'});

    await client.query('BEGIN');

    const { rows: childCat } = await client.query(`SELECT 1 FROM public.categoria WHERE id_padre=$1 AND activo=true LIMIT 1`,[id]);
    if(childCat.length){ await client.query('ROLLBACK'); return res.status(400).json({message:'No se puede eliminar: tiene subcategorías activas'}); }

    const { rows: hasProd } = await client.query(`SELECT 1 FROM public.producto WHERE id_categoria=$1 AND activo=true LIMIT 1`,[id]);
    if(hasProd.length){ await client.query('ROLLBACK'); return res.status(400).json({message:'No se puede eliminar: hay productos activos en esta categoría'}); }

    const { rowCount } = await client.query(`UPDATE public.categoria SET activo=false WHERE id_categoria=$1`,[id]);
    if(!rowCount){ await client.query('ROLLBACK'); return res.status(404).json({message:'No encontrada'}); }

    await client.query(`
      INSERT INTO public.auditoria (actor_id, target_tipo, action, payload, created_at)
      VALUES ($1, 'categoria', 'CAT_DISABLE', $2::jsonb, NOW())
    `,[req.user.id || req.user.sub, JSON.stringify({ id_categoria: id })]);

    await client.query('COMMIT');
    res.json({ message:'Categoría desactivada' });
  }catch(err){ try{await pool.query('ROLLBACK')}catch{}; next(err); }
  finally{ client.release(); }
});

module.exports = router;
