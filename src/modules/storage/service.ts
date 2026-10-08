import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { AIFile, SaveFilesFunction } from '@/core/ai';
import { R2Provider, StorageManager } from '@/core/storage';
import { getAllConfigs, type ConfigMap } from '@/modules/config/service';

/**
 * Storage config is DB-driven (like auth/payment/email): values come from the
 * admin "Storage" settings, merged over env via getAllConfigs(). Keys mirror the
 * original ShipAny Two (`r2_*`).
 */
function isConfigured(configs: ConfigMap): boolean {
  return Boolean(
    configs.r2_access_key && configs.r2_secret_key && configs.r2_bucket_name
  );
}

function buildManager(configs: ConfigMap): StorageManager {
  const manager = new StorageManager();
  manager.addProvider(
    new R2Provider({
      accountId: configs.r2_account_id || '',
      accessKeyId: configs.r2_access_key as string,
      secretAccessKey: configs.r2_secret_key as string,
      bucket: configs.r2_bucket_name as string,
      uploadPath: configs.r2_upload_path,
      region: 'auto',
      endpoint: configs.r2_endpoint, // optional custom endpoint
      publicDomain: configs.r2_domain,
    }),
    true
  );
  return manager;
}

export async function isStorageConfigured(): Promise<boolean> {
  return isConfigured(await getAllConfigs());
}

/**
 * Returns a configured StorageManager, or null when storage is not configured
 * (caller should fall back to local/inline handling).
 */
export async function getStorage(): Promise<StorageManager | null> {
  const configs = await getAllConfigs();
  if (!isConfigured(configs)) return null;
  return buildManager(configs);
}

// --- Remote file persistence ---------------------------------------------

const IMAGE_EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

/** Sanitize a storage key before it reaches the local-filesystem fallback. */
function safeRelativeKey(key: string): string {
  const cleaned = key
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .map((seg) => seg.replace(/[^\w.\-]/g, '_'))
    .join('/');
  if (!cleaned) throw new Error('invalid storage key');
  return cleaned;
}

function extFromContentType(contentType: string): string {
  const mime = contentType.split(';')[0]?.trim().toLowerCase() || '';
  return IMAGE_EXT_BY_MIME[mime] || 'png';
}

/**
 * Store raw bytes and return the URL to serve them from.
 *
 * Falls back to writing under `public/generated/` when no storage provider is
 * configured — that keeps local dev working with zero setup, but note the
 * directory is only served as static output when the file existed at build
 * time, so the fallback is a development affordance rather than production
 * storage.
 */
export async function persistFileBytes(params: {
  body: Uint8Array;
  key: string;
  contentType?: string;
}): Promise<string> {
  const key = safeRelativeKey(params.key);
  const contentType = params.contentType || 'application/octet-stream';

  const storage = await getStorage();
  if (storage) {
    const result = await storage.uploadFile({
      body: params.body,
      key,
      contentType,
      disposition: 'inline',
    });
    if (result.success && result.url) return result.url;
    throw new Error(result.error || 'upload file failed');
  }

  const target = path.join(process.cwd(), 'public', 'generated', key);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, params.body);
  return `/generated/${key}`;
}

/**
 * Download budget, per attempt.
 *
 * `STALL` carries the weight. A wall-clock deadline cannot tell a large file
 * arriving slowly from a socket that has hung, so it kills the first — and a
 * burst of concurrent illustration downloads is exactly the slow-but-moving
 * case. Watching for silence separates them, and still fails fast on a hang.
 */
const DOWNLOAD_STALL_MS = 30_000;
const DOWNLOAD_DEADLINE_MS = 5 * 60 * 1000;
const DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_RETRY_BASE_MS = 400;

/** A download failure, and whether another attempt could plausibly help. */
class DownloadError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

/** Statuses worth a second look; anything else is the server's final answer. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch a remote file, failing only once the transfer stops making progress.
 *
 * The body is accumulated by hand rather than with `resp.arrayBuffer()` so that
 * each chunk can re-arm the stall watchdog; the bytes produced are identical.
 */
async function downloadRemoteFile(url: string): Promise<{
  bytes: Uint8Array;
  contentType: string | null;
}> {
  const controller = new AbortController();
  const startedAt = Date.now();
  let stallTimer: ReturnType<typeof setTimeout> | undefined;

  const watchForStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(
      () => controller.abort(new Error(`no data for ${DOWNLOAD_STALL_MS}ms`)),
      DOWNLOAD_STALL_MS
    );
  };

  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) {
      throw new DownloadError(
        `download failed: ${resp.status}`,
        isRetryableStatus(resp.status)
      );
    }

    const contentType = resp.headers.get('content-type');
    if (!resp.body) {
      return { bytes: new Uint8Array(await resp.arrayBuffer()), contentType };
    }

    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    watchForStall();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      watchForStall();
      chunks.push(value);
      total += value.byteLength;
      if (Date.now() - startedAt > DOWNLOAD_DEADLINE_MS) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`download exceeded ${DOWNLOAD_DEADLINE_MS}ms`);
      }
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes, contentType };
  } finally {
    clearTimeout(stallTimer);
  }
}

/**
 * Retry the download a couple of times.
 *
 * Only a definite "no" from the server (404, 403 — the file really is gone)
 * is passed through untouched; a timeout or a 5xx is worth another go. The
 * backoff is jittered because a burst of images that stalled together would
 * otherwise retry in lockstep and stall together again.
 */
async function downloadWithRetry(url: string) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      return await downloadRemoteFile(url);
    } catch (error) {
      lastError = error;
      if (error instanceof DownloadError && !error.retryable) throw error;
      if (attempt === DOWNLOAD_ATTEMPTS) break;
      await sleep(
        DOWNLOAD_RETRY_BASE_MS * 2 ** (attempt - 1) * (1 + Math.random())
      );
    }
  }
  throw lastError;
}

/**
 * Download a remote file and store it durably, returning the URL to serve it
 * from. Generated-media URLs (Replicate, Fal, …) expire after about an hour,
 * so anything we intend to keep must be copied off the provider.
 *
 * Idempotent: a retry writes the same key, so a half-finished attempt costs
 * nothing but bandwidth.
 */
export async function persistRemoteFile(params: {
  url: string;
  key: string;
  contentType?: string;
}): Promise<string> {
  const { bytes, contentType } = await downloadWithRetry(params.url);
  return persistFileBytes({
    body: bytes,
    key: params.key,
    contentType: params.contentType || contentType || 'image/png',
  });
}

/**
 * Public URL for a key we own, for handing to a third-party service.
 *
 * Throws when no public domain is configured instead of returning the S3
 * endpoint URL. That endpoint is private (signed requests only), so a provider
 * asked to fetch it just gets a 403 — a failure a long way from its cause.
 */
export async function buildPublicUrl(key: string): Promise<string> {
  const configs = await getAllConfigs();
  const storage = await getStorage();
  if (!storage) throw new Error('Storage is not configured');

  const domain = (configs.r2_domain as string | undefined)?.trim();
  const url = storage.getPublicUrl({ key: safeRelativeKey(key) });

  if (!url || !domain) {
    throw new Error(
      'Storage has no public domain configured — set "Public Domain" under admin → Storage. Without it this URL is private and external services cannot fetch it.'
    );
  }
  return url;
}

/**
 * Copy an object we already store into a new key, returning the new URL.
 *
 * Used to give each book its own private copy of a user's reference photo:
 * uploads are content-addressed and deduplicated across users, so they must
 * never be deleted directly.
 */
export async function copyStoredObject(params: {
  fromKey: string;
  toKey: string;
  contentType?: string;
}): Promise<string> {
  return persistRemoteFile({
    url: await buildPublicUrl(params.fromKey),
    key: params.toKey,
    contentType: params.contentType,
  });
}

/**
 * Best-effort delete.
 *
 * Never throws: this cleans up reference photos after a book settles, and a
 * failed delete must not turn a successful generation into a failed one.
 */
export async function deleteStoredObjects(keys: string[]): Promise<void> {
  const targets = keys.filter(Boolean);
  if (!targets.length) return;

  const storage = await getStorage();
  for (const raw of targets) {
    try {
      const key = safeRelativeKey(raw);
      if (storage) {
        await storage.deleteFile({ key });
      } else {
        await rm(path.join(process.cwd(), 'public', 'generated', key), {
          force: true,
        });
      }
    } catch (error) {
      console.error('delete stored object failed:', raw, error);
    }
  }
}

/**
 * Delete objects living in the shared `uploads/` namespace — the one the image
 * upload route writes to, keyed by the md5 of the bytes.
 *
 * Two differences from `deleteStoredObjects`, both of which silently delete the
 * wrong thing if ignored:
 *
 * - The storage provider prepends its own upload path (`uploads/` by default),
 *   so the key has to be relative to it: `uploads/abc.jpg` is object
 *   `uploads/abc.jpg`, which is `deleteFile({ key: 'abc.jpg' })`. Callers pass
 *   the key in either shape — the upload route returns it with the prefix, a
 *   stored plan may hold it without — so it is stripped here, in one place.
 * - With no storage configured the dev fallback writes these to
 *   `public/uploads/`, not `public/generated/`.
 *
 * Best-effort, like `deleteStoredObjects`: a failed delete means an object
 * lingers, and must not fail the operation that was cleaning up.
 *
 * Note on de-duplication: uploads are content-addressed, so the same bytes
 * uploaded twice share one object. Deleting it is therefore only safe once
 * nothing else needs it — see the callers, which run this when a book settles
 * and its own copies already exist.
 */
export async function deleteUploadedObjects(keys: string[]): Promise<void> {
  const targets = keys
    .map((key) => key.replace(/\\/g, '/').replace(/^\/+/, ''))
    .map((key) => key.replace(/^uploads\//, ''))
    .filter(Boolean);
  if (!targets.length) return;

  const storage = await getStorage();
  for (const raw of targets) {
    try {
      const key = safeRelativeKey(raw);
      if (storage) {
        await storage.deleteFile({ key });
      } else {
        await rm(path.join(process.cwd(), 'public', 'uploads', key), {
          force: true,
        });
      }
    } catch (error) {
      console.error('delete uploaded object failed:', raw, error);
    }
  }
}

/**
 * Build the `saveFiles` hook that core/ai providers call once a generation
 * finishes (Replicate/Fal only run it when `customStorage: true`).
 *
 * Keys are derived from `scope` + the file's index rather than the provider's
 * own random key: the same slot always maps to the same object, so a repeated
 * or concurrent poll overwrites harmlessly instead of littering the bucket.
 *
 * Pass `index` when the caller knows the slot (one image per provider
 * generation, e.g. a storybook page) — providers report index 0 for every
 * single-image result, which would otherwise collide across slots.
 *
 * `index` names the object only. The file's own `index` is the provider's
 * position in its result array, and providers use it to write the stored URL
 * back into their `images[]` — overwriting it with our slot number made that
 * write-back miss for every slot past the first (a single-image provider
 * returns one element, so `images[1]` is undefined), which surfaced as
 * "not persisted to storage" on every storybook page after the cover.
 */
export function makeSaveFiles(
  scope: string,
  opts?: { index?: number }
): SaveFilesFunction {
  const prefix = safeRelativeKey(scope);
  return async (files: AIFile[]): Promise<AIFile[]> => {
    const saved: AIFile[] = [];
    for (const file of files) {
      if (!file?.url) continue;
      const slot = opts?.index ?? file.index ?? saved.length;
      const key = `${prefix}/${slot}.${extFromContentType(file.contentType)}`;
      const url = await persistRemoteFile({
        url: file.url,
        key,
        contentType: file.contentType,
      });
      saved.push({ ...file, url, key });
    }
    return saved;
  };
}
