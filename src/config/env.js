const { z } = require('zod');
require('dotenv').config();

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url().default("postgres://postgres:admin@localhost:5432/Bananobd"),
  PGPOOL_MIN: z.coerce.number().int().min(0).default(0),
  PGPOOL_MAX: z.coerce.number().int().min(1).default(10),
  PGPOOL_IDLE_MS: z.coerce.number().int().min(0).default(10000),
  PGSSL: z.string().optional(), 
  JWT_SECRET: z.string().min(10).default("134d1babfe24a1ecdae31fbe1a189143f7d5f03088bd901e823ae249af8679c1"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ Variables de entorno inválidas:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

module.exports = parsed.data;
