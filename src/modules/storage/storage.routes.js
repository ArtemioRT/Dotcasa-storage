// ============================================================================
// MÓDULO STORAGE — procesamiento de imágenes, watermark, uploads y borrado
// ============================================================================
import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import {
  gcsBucket, GCS_BUCKET_NAME, OPENAI_API_KEY,
  MAX_IMAGE_WIDTH, MAX_IMAGE_HEIGHT, WEBP_QUALITY
} from '../../shared/config.js';
import { parseUrlList, computeContentHash, makeDedupName } from '../../shared/utils.js';
import {
  downloadImage, gcsFileExists, streamPipelineToGCS, processAllLimited
} from '../../shared/imageUtils.js';
import { createImageJob, getImageJob, runImageJobInBackground } from './imageJobs.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// ============================================================================
// POST /process-images/process — Inicia el job, responde job_id inmediatamente
// ============================================================================
router.post('/process-images/process', async (req, res) => {
  console.log('\n' + '='.repeat(70));
  console.log('🚀 PROCESS-IMAGES/PROCESS — Creando job async');
  console.log('='.repeat(70));

  try {
    const { image_urls, target_format, resize } = req.body;
    if (!image_urls) return res.status(400).json({ error: 'image_urls requerido' });
    if (!OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY no configurada' });

    const urlList = [...new Set(parseUrlList(image_urls))];
    const format = (target_format || 'webp').toLowerCase();

    if (!urlList.length) return res.status(400).json({ error: 'No se encontraron URLs válidas en image_urls' });

    const jobId = createImageJob(urlList);
    console.log(`📋 Job creado: ${jobId} | ${urlList.length} URLs`);

    // Dispara el procesamiento en background sin bloquear la respuesta HTTP
    runImageJobInBackground(jobId, urlList, format, resize).catch(err => {
      console.error(`[Job ${jobId}] Error no capturado en background:`, err.message);
    });

    // Respuesta inmediata — el job apenas arranca, urls[] estará vacío
    return res.json({
      job_id:   jobId,
      status:   'processing',
      url:      '',
      all_urls: '',
      total:    urlList.length,
      done:     0,
    });

  } catch (err) {
    console.error('CRITICAL ERROR en /process-images/process:', err.message);
    res.status(500).json({ error: 'Internal server error', message: err.message });
  }
});

// ============================================================================
// POST /process-images/progress — Consulta el estado actual de un job
// ============================================================================
router.post('/process-images/progress', (req, res) => {
  const { job_id } = req.body;

  if (!job_id) return res.status(400).json({ error: 'job_id requerido' });

  const job = getImageJob(job_id);
  if (!job) return res.status(404).json({ error: 'job_id no encontrado o ya expiró (máx 15 min)' });

  const cleanUrls = job.urls;

  // Forzamos el formato de texto plano: "url1","url2","url3"
  const formattedUrlsText = cleanUrls.map(url => `"${url}"`).join(',');

  return res.json({
    job_id,
    status:     job.status,           // 'processing' | 'done'
    url:        cleanUrls[0] || '',   // primera URL lista (preview rápido en Bubble)
    all_urls:   formattedUrlsText,    // <- Devuelve un único texto: "url1","url2"
    total:      job.total,
    done:       job.done,
    successful: cleanUrls.length,
    flagged:    job.flagged,
    errors:     job.errors,
  });
});

// ============================================================================
// POST /apply-watermark
// ============================================================================
router.post('/apply-watermark', async (req, res) => {
  try {
    const { urls, url_watermark } = req.body;
    if (!urls || !url_watermark) return res.status(400).json({ error: 'urls y url_watermark requeridos' });
    const urlList = [...new Set(parseUrlList(urls))];

    const watermarkRaw = await downloadImage(url_watermark);
    const watermarkResized = await sharp(watermarkRaw)
      .resize(MAX_IMAGE_WIDTH, MAX_IMAGE_HEIGHT, { fit: 'fill' })
      .ensureAlpha()
      .toBuffer();
    const watermarkHash = computeContentHash(watermarkRaw).substring(0, 12);

    const processor = async (url, idx) => {
      const buffer = await downloadImage(url);
      const contentHash = computeContentHash(buffer);
      const filename = makeDedupName(contentHash, `wm_${watermarkHash}`, 'webp');

      const cached = await gcsFileExists(filename);
      if (cached) return { success: true, url: cached };

      const pipeline = sharp(buffer)
        .resize(MAX_IMAGE_WIDTH, MAX_IMAGE_HEIGHT, { fit: 'cover' })
        .composite([{ input: watermarkResized, left: 0, top: 0, blend: 'over' }])
        .webp({ quality: WEBP_QUALITY });

      const { url: uploadedUrl } = await streamPipelineToGCS(filename, 'image/webp', pipeline);
      return { success: true, url: uploadedUrl };
    };

    const results = await processAllLimited(urlList, processor);
    res.json({ url: results[0]?.url, all_urls: results.map(r => r.url).join(',') });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// POST /storage/delete
// ============================================================================
router.post('/storage/delete', async (req, res) => {
  try {
    const { url } = req.body;
    const prefix = `https://storage.googleapis.com/${GCS_BUCKET_NAME}/`;
    if (!url || !url.startsWith(prefix)) return res.status(400).json({ error: 'URL inválida' });
    await gcsBucket.file(url.substring(prefix.length)).delete();
    return res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// POST /storage/upload — Versión Oficial Estricta Alineada con Uppy (bundle: true)
// ============================================================================
router.post('/storage/upload', upload.array('files[]', 20), async (req, res) => {
  const t0 = Date.now();

  console.log('\n' + '='.repeat(70));
  console.log('🚀 [BACKEND] INICIANDO SUBIDA DIRECTA EN LOTE');
  console.log('='.repeat(70));

  try {
    if (!req.files || req.files.length === 0) {
      console.error('❌ [BACKEND ERROR] No se recibieron archivos en "files[]".');

      return res.status(400).json({
        url: '',
        uploadURL: '',
        urls: [],
        file: '',
        files: [],
        urls_text: '',
        error: 'El servidor no recibió archivos bajo la estructura esperada ("files[]").'
      });
    }

    console.log(`📦 Archivos recibidos: ${req.files.length}`);

    const uploadPromises = req.files.map(async (file, index) => {
      console.log(
        `[Archivo ${index + 1}] Procesando: "${file.originalname}" | Tamaño: ${(file.size / 1024).toFixed(1)} KB`
      );

      const fileExt = file.originalname.includes('.')
        ? file.originalname.split('.').pop()
        : 'bin';

      const cleanBaseName = file.originalname
        .replace(`.${fileExt}`, '')
        .replace(/[^a-zA-Z0-9]/g, '_')
        .substring(0, 50);

      const uniqueFilename = `uploads/${Date.now()}_${index}_${cleanBaseName}.${fileExt}`;
      const gcsFile = gcsBucket.file(uniqueFilename);
      const contentType = file.mimetype || 'application/octet-stream';

      await gcsFile.save(file.buffer, {
        metadata: {
          contentType,
          cacheControl: 'public, max-age=31536000'
        },
        resumable: false,
        validation: false
      });

      const publicUrl = `https://storage.googleapis.com/${GCS_BUCKET_NAME}/${uniqueFilename}`;

      console.log(`✓ [Archivo ${index + 1}] Subido -> ${publicUrl}`);

      return publicUrl;
    });

    const uploadedUrls = await Promise.all(uploadPromises);
    const firstUrl = uploadedUrls[0] || '';
    const urlsText = uploadedUrls.map(url => `"${url}"`).join(',');

    const dur = ((Date.now() - t0) / 1000).toFixed(2);
    console.log(`🏁 [BACKEND] Subida finalizada en ${dur}s`);

    return res.status(200).json({
      // Para Uppy
      url: firstUrl,
      uploadURL: firstUrl,

      // Para Bubble / listas
      urls: uploadedUrls,
      urls_text: urlsText,

      // Compatibilidad con tu respuesta actual
      file: firstUrl,
      files: uploadedUrls,

      total: uploadedUrls.length,
      success: true
    });

  } catch (err) {
    console.error('💥 [BACKEND CRITICAL ERROR]:', err.message);

    return res.status(500).json({
      url: '',
      uploadURL: '',
      urls: [],
      urls_text: '',
      file: '',
      files: [],
      success: false,
      error: `Error crítico en el servidor: ${err.message}`
    });
  }
});

export default router;