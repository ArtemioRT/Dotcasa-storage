// ============================================================================
// CONFIGURACIÓN GLOBAL — env, Google Cloud Storage y constantes
// ============================================================================
import 'dotenv/config';
import { Storage } from '@google-cloud/storage';

export const PORT = process.env.PORT || 3000;
export const IS_PROD = process.env.NODE_ENV === 'production';

// --- Google Cloud Storage ---
export const GCS_BUCKET_NAME = process.env.GCS_BUCKET;
if (!GCS_BUCKET_NAME) {
  console.error('❌ GCS_BUCKET no está configurada en las variables de entorno');
  process.exit(1);
}

export const gcsClient = new Storage();
export const gcsBucket = gcsClient.bucket(GCS_BUCKET_NAME);
console.log(`✓ GCS bucket configurado: ${GCS_BUCKET_NAME}`);

// --- Timeouts / reintentos ---
export const DOWNLOAD_TIMEOUT = 30000;
export const UPLOAD_TIMEOUT = 30000;
export const MAX_RETRIES = 2;
export const RETRY_DELAY_BASE = 500;

// --- Límites de imágenes ---
export const MAX_URLS_PER_REQUEST = 200;
export const MAX_IMAGE_SIZE_MB = 30;
export const MAX_IMAGE_WIDTH = 800;
export const MAX_IMAGE_HEIGHT = 600;
export const HEIC_QUALITY = 0.7;
export const WEBP_QUALITY = 75;

// --- Chatbot / resultados ---
export const MIN_RESULTS_THRESHOLD = 3;
export const MIN_VISIBLE_TARGET = 15;
export const INITIAL_DISPLAY_COUNT = 3;
export const MAX_PROPERTIES_TO_SHOW = 20;

// --- Servicios externos ---
export const BUBBLE_SEARCH_URL = process.env.BUBBLE_SEARCH_URL;
export const GOTENBERG_URL = process.env.GOTENBERG_URL;
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
export const NOMINATIM_UA = 'DotCasa-Chatbot/2.0';
