// ============================================================================
// DOTCASA-STORAGE — Procesamiento de imágenes, uploads y borrado en GCS
// ============================================================================
// El logger va PRIMERO: parchea console.* a JSON estructurado en Cloud Run
// antes de que cualquier otro módulo escriba logs.
import { logger } from './src/shared/logger.js';
import express from 'express';
import cors from 'cors';
import { PORT } from './src/shared/config.js';
import storageRoutes from './src/modules/storage/storage.routes.js';

const app = express();

// ---------------------------------------------------------------------------
// Middleware global
// ---------------------------------------------------------------------------
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use((req, res, next) => {
  req.setTimeout(120_000, () => {
    if (!res.headersSent) res.status(503).json({ error: 'Request timeout (120s)' });
  });
  next();
});

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------
app.use(storageRoutes);

app.get('/health', (req, res) => res.json({ service: 'dotcasa-storage', status: 'ok' }));
app.get('/ping', (req, res) => res.send('pong'));

// ---------------------------------------------------------------------------
// Manejo de errores centralizado
// ---------------------------------------------------------------------------
// 404 — ninguna ruta coincidió
app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada', path: req.path });
});

// Red de seguridad: errores que las rutas no atraparon (incluye errores de
// multer, JSON malformado en el body, y cualquier next(err))
app.use((err, req, res, next) => {
  logger.error('Error no controlado', {
    path: req.path,
    method: req.method,
    error: err.message,
    stack: err.stack,
  });
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: 'Error interno del servidor', message: err.message });
});

// Errores a nivel de proceso — que siempre queden registrados antes de morir
process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', { error: reason?.message || String(reason), stack: reason?.stack });
});
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', { error: err.message, stack: err.stack });
  process.exit(1);
});

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`dotcasa-storage inicializado en puerto ${PORT}`);
});
