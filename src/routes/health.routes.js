const { Router } = require('express');
const { ping } = require('../db/pool');

const router = Router();

router.get('/health', async (_req, res, next) => {
  try {
    const ok = await ping();
    res.json({
      status: ok ? 'ok' : 'error',
      time: new Date().toISOString(),
      database: ok ? 1 : 0
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
