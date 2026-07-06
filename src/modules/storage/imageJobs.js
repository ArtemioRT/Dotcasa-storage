// ============================================================================
// JOB STORE — Estado en memoria RAM para process-images async
// ============================================================================
import crypto from 'crypto';
import axios from 'axios';
import sharp from 'sharp';
import {
  gcsBucket, OPENAI_API_KEY,
  MAX_IMAGE_WIDTH, MAX_IMAGE_HEIGHT, WEBP_QUALITY
} from '../../shared/config.js';
import { computeContentHash, makeDedupName } from '../../shared/utils.js';
import {
  downloadImage, hasTransparency, gcsFileExists,
  streamPipelineToGCS, processAllLimited
} from '../../shared/imageUtils.js';

const imageJobStore = new Map();

export function getImageJob(jobId) {
  return imageJobStore.get(jobId);
}

export function createImageJob(urlList) {
  const jobId = crypto.randomUUID();
  imageJobStore.set(jobId, {
    status: 'processing',   // 'processing' | 'done'
    urls: [],               // URLs procesadas exitosamente (se acumulan conforme terminan)
    total: urlList.length,
    done: 0,                // imágenes finalizadas (éxito + flagged + error)
    errors: 0,
    flagged: 0,
    startedAt: Date.now(),
  });
  // Auto-limpieza a los 15 minutos para no acumular basura en RAM
  setTimeout(() => imageJobStore.delete(jobId), 15 * 60 * 1000);
  return jobId;
}

export async function runImageJobInBackground(jobId, urlList, format, resize) {
  const job = imageJobStore.get(jobId);
  if (!job) return;

  const processOne = async (url, index) => {
    const startTime = Date.now();
    try {
      const buffer = await downloadImage(url);
      const isTransparent = await hasTransparency(buffer);
      const contentHash = computeContentHash(buffer);
      const filename = makeDedupName(contentHash, `proc_${format}_r_${resize !== false}`, 'webp');

      // Caché GCS — si ya existe, la URL se suma sin reprocesar
      const cached = await gcsFileExists(filename);
      if (cached) {
        console.log(`[Job ${jobId}][Foto ${index + 1}] ✓ Caché GCS`);
        job.urls.push(cached);
        job.done++;
        return;
      }

      let pipeline = sharp(buffer);
      if (resize !== false) {
        pipeline = pipeline.resize(MAX_IMAGE_WIDTH, MAX_IMAGE_HEIGHT, { fit: 'cover' });
      }
      pipeline = pipeline.webp({ quality: WEBP_QUALITY, lossless: isTransparent });

      const { url: uploadedUrl, bytes } = await streamPipelineToGCS(filename, 'image/webp', pipeline);

      // Moderación OpenAI
      console.log(`[Job ${jobId}][Foto ${index + 1}] 🤖 Moderando...`);
      const moderationRes = await axios.post(
        'https://api.openai.com/v1/moderations',
        { input: uploadedUrl },
        { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 10000 }
      );

      const isFlagged = moderationRes.data.results[0]?.flagged || false;
      if (isFlagged) {
        console.warn(`[Job ${jobId}][Foto ${index + 1}] ❌ Flagged — eliminando de GCS`);
        await gcsBucket.file(filename).delete().catch(() => {});
        job.flagged++;
        job.done++;
        return;
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`[Job ${jobId}][Foto ${index + 1}] ✓ OK ${duration}s (${Math.round(bytes / 1024)} KB)`);
      job.urls.push(uploadedUrl);
      job.done++;

    } catch (err) {
      console.error(`[Job ${jobId}][Foto ${index + 1}] 💥 ${err.message}`);
      job.errors++;
      job.done++;
    }
  };

  try {
    await processAllLimited(urlList, processOne);
  } catch (err) {
    console.error(`[Job ${jobId}] 💥 Error global del lote: ${err.message}`);
  } finally {
    if (job) {
      job.status = 'done';
      const dur = ((Date.now() - job.startedAt) / 1000).toFixed(2);
      console.log(`[Job ${jobId}] 🏁 COMPLETADO en ${dur}s | ✓ ${job.urls.length} | flagged: ${job.flagged} | errores: ${job.errors}`);
    }
  }
}
