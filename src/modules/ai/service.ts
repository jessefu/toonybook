import {
  AIManager,
  AIMediaType,
  AITaskStatus,
  FalProvider,
  GeminiProvider,
  KieProvider,
  ReplicateProvider,
  type SaveFilesFunction,
} from '@/core/ai';
import { getAllConfigs, type ConfigMap } from '@/modules/config/service';
import { makeSaveFiles, persistFileBytes } from '@/modules/storage/service';

/**
 * AI provider assembly, DB-config driven like storage/payment/auth: values
 * come from the admin "AI" settings, merged over env via getAllConfigs().
 *
 * This is the single place that knows how a provider row turns into a live
 * core/ai provider. Feature modules (storybook, …) ask for a manager here
 * instead of talking to vendor HTTP APIs themselves.
 */

export type ImageProviderKind = 'replicate' | 'fal' | 'kie' | 'gemini';
export type TextProviderKind = 'openai' | 'anthropic' | 'kie' | 'builtin';

/**
 * Model ids are namespaced per vendor — a blank `ai_image_model` must not hand
 * Replicate's id to Kie. Keep these in sync with `settings-test-specs.ts`.
 */
export const DEFAULT_IMAGE_MODELS: Record<ImageProviderKind, string> = {
  replicate: 'black-forest-labs/flux-schnell',
  fal: 'fal-ai/flux/schnell',
  kie: 'google/nano-banana',
  gemini: 'gemini-2.0-flash-preview-image-generation',
};

/**
 * Same reasoning as `DEFAULT_IMAGE_MODELS`: a blank `ai_text_model` has to mean
 * something the *selected* provider accepts. Kie in particular rejects most of
 * the ids its own `/api/v1/models` catalogue advertises — of the Chat models,
 * `gpt-5-2` answers and a long list (gpt-5-6-*, claude-*, gemini-3-8-flash, …)
 * comes back `422 The model is not supported`, so the default is the one that
 * was measured working rather than the newest name in the catalogue.
 */
export const DEFAULT_TEXT_MODELS: Record<TextProviderKind, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-4-5',
  kie: 'gpt-5-2',
  // Never reached: `generateText` returns null before asking for a model.
  builtin: '',
};

/**
 * Where a model wants its reference images, when the admin hasn't said.
 *
 * Every vendor names this key differently and the ids are inconsistent about
 * namespacing (`google/nano-banana-edit` is prefixed, `nano-banana-pro` is
 * not), so this is a lookup rather than a convention. Anything unmatched falls
 * back to the most common name; `ai_image_input_field` overrides it outright.
 *
 * First match wins, so put the longer/more specific ids first.
 */
const IMAGE_INPUT_FIELD_BY_MODEL: Array<[RegExp, string]> = [
  // Kie
  [/^google\/nano-banana-edit$/, 'image_urls'],
  [/^nano-?banana-(pro|2)$/, 'image_input'],
  [/^seedream\//, 'image_urls'],
  [/^ideogram\//, 'reference_image_urls'],
  [/^flux1-kontext$/, 'input_image'],
  // fal — many of the same models under fal's own ids
  [/^fal-ai\/nano-banana\/edit$/, 'image_urls'],
  [/^fal-ai\/gemini-[\d.-]*pro-image[\w-]*\/edit$/, 'image_urls'],
  [/^fal-ai\/flux-pro\/kontext\/max\/multi$/, 'image_urls'],
  [/^fal-ai\/flux-pro\/kontext/, 'image_url'],
  [/^fal-ai\/bytedance\/seedream\/[\w.-]*\/edit$/, 'image_urls'],
  [/^fal-ai\/ideogram\//, 'reference_image_urls'],
];

const DEFAULT_IMAGE_INPUT_FIELD = 'image_urls';

/** Fields that take a single URL rather than an array. */
const SINGLE_IMAGE_INPUT_FIELDS = new Set(['input_image', 'image_url']);

const IMAGE_FALLBACK_ORDER: ImageProviderKind[] = [
  'replicate',
  'fal',
  'kie',
  'gemini',
];

function isImageProviderAvailable(
  kind: ImageProviderKind,
  configs: ConfigMap
): boolean {
  switch (kind) {
    case 'replicate':
      return Boolean(configs.replicate_api_token);
    case 'fal':
      return Boolean(configs.fal_api_key);
    case 'kie':
      return Boolean(configs.kie_api_key);
    case 'gemini':
      return Boolean(configs.gemini_api_key);
  }
}

/**
 * Which image provider to actually use, or null when none is configured.
 *
 * Honors `ai_image_provider`, but falls back to any other provider that has
 * credentials so a stale setting can't break generation. There is deliberately
 * no keyless default: image generation is the one thing a picture book cannot
 * fake, so callers fail fast and tell the admin what to configure rather than
 * burning credits on a request that cannot succeed.
 */
export function resolveImageProvider(
  configs: ConfigMap
): ImageProviderKind | null {
  const requested = configs.ai_image_provider as
    ImageProviderKind | 'auto' | undefined;
  if (
    requested &&
    requested !== 'auto' &&
    isImageProviderAvailable(requested, configs)
  ) {
    return requested;
  }
  return (
    IMAGE_FALLBACK_ORDER.find((kind) =>
      isImageProviderAvailable(kind, configs)
    ) ?? null
  );
}

/**
 * Which text provider to use. `builtin` means "no LLM configured" — callers
 * are expected to fall back to their own offline content.
 */
export function resolveTextProvider(configs: ConfigMap): TextProviderKind {
  const requested = configs.ai_text_provider as
    TextProviderKind | 'auto' | undefined;
  if (requested === 'openai' && configs.openai_api_key) return 'openai';
  if (requested === 'anthropic' && configs.anthropic_api_key)
    return 'anthropic';
  if (requested === 'kie' && configs.kie_api_key) return 'kie';
  if (requested === 'builtin') return 'builtin';

  // `auto` order matters: an existing OpenAI/Anthropic key keeps winning, so
  // adding Kie support can't quietly move someone's text generation to a new
  // vendor. Kie is consulted last, and only when nothing else has a key.
  if (configs.openai_api_key) return 'openai';
  if (configs.anthropic_api_key) return 'anthropic';
  if (configs.kie_api_key) return 'kie';
  return 'builtin';
}

/**
 * Model to ask for. An explicit `ai_image_model` always wins; otherwise the
 * provider's own default is used, resolved from `provider` or, when the caller
 * hasn't picked one yet, from the configured provider.
 */
export function getImageModel(
  configs: ConfigMap,
  provider?: ImageProviderKind | null
): string {
  if (configs.ai_image_model) return configs.ai_image_model;
  const kind = provider ?? resolveImageProvider(configs);
  // No provider configured: the value is unused, but callers persist it in the
  // task plan, so hand back something stable rather than an empty string.
  return DEFAULT_IMAGE_MODELS[kind ?? 'replicate'];
}

/**
 * Model to ask for. An explicit `ai_text_model` always wins — the admin knows
 * their vendor's catalogue better than this table does; the per-provider
 * default only covers the blank case.
 */
export function getTextModel(
  configs: ConfigMap,
  provider?: TextProviderKind | null
): string {
  if (configs.ai_text_model) return configs.ai_text_model;
  const kind = provider ?? resolveTextProvider(configs);
  return DEFAULT_TEXT_MODELS[kind];
}

/**
 * Model to use when the caller supplies reference images.
 *
 * Deliberately has no per-provider default. Getting this wrong ships the
 * user's photo to a model that ignores it, and the result looks like the
 * photo's fault rather than the config's — so an unset value is an error the
 * caller must surface, not something to guess at.
 */
export function getImageEditModel(configs: ConfigMap): string {
  return (configs.ai_image_edit_model as string) || '';
}

/** Which input key this model expects for reference images. */
export function resolveImageInputField(
  configs: ConfigMap,
  model: string
): string {
  if (configs.ai_image_input_field) return configs.ai_image_input_field;
  const match = IMAGE_INPUT_FIELD_BY_MODEL.find(([re]) => re.test(model));
  return match?.[1] ?? DEFAULT_IMAGE_INPUT_FIELD;
}

/** Thrown when reference images are requested but no edit model is configured. */
export const NO_IMAGE_EDIT_MODEL = 'No reference-image model configured';

/**
 * Build an AIManager from already-loaded configs (sync — handy for tests and
 * for callers that already have the config map in hand).
 */
export function buildAIManager(
  configs: ConfigMap,
  saveFiles: SaveFilesFunction
): AIManager {
  const manager = new AIManager();

  if (configs.replicate_api_token) {
    manager.addProvider(
      new ReplicateProvider({
        apiToken: configs.replicate_api_token,
        // Makes query() copy finished media into our own storage and hand
        // back our URL instead of Replicate's expiring one.
        customStorage: true,
        saveFiles,
      })
    );
  }

  if (configs.fal_api_key) {
    manager.addProvider(
      new FalProvider({
        apiKey: configs.fal_api_key,
        customStorage: true,
        saveFiles,
      })
    );
  }

  if (configs.kie_api_key) {
    manager.addProvider(
      new KieProvider({
        apiKey: configs.kie_api_key,
        customStorage: true,
        saveFiles,
      })
    );
  }

  if (configs.gemini_api_key) {
    manager.addProvider(
      new GeminiProvider({
        apiKey: configs.gemini_api_key,
        // Gemini returns image bytes inline rather than behind a URL, so this
        // provider uploads directly instead of downloading first.
        uploadFile: async ({ body, key, contentType }) => ({
          url: await persistFileBytes({ body, key, contentType }),
        }),
      })
    );
  }

  return manager;
}

/**
 * Configured AIManager for the current request.
 *
 * `saveFiles` defaults to a storage-backed implementation so generated media
 * is always persisted — pass a scoped one (see `makeSaveFiles`) to get
 * deterministic object keys tied to your own entity id.
 */
export async function getAIManager(opts?: {
  saveFiles?: SaveFilesFunction;
}): Promise<AIManager> {
  const configs = await getAllConfigs();
  return buildAIManager(
    configs,
    opts?.saveFiles ?? makeSaveFiles('ai/generated')
  );
}

// --- Image generation -----------------------------------------------------

export type ImageJobStatus = 'processing' | 'success' | 'failed';

export interface ImageJob {
  provider: ImageProviderKind;
  /** Provider-side handle for `pollImageJob()`. Empty for synchronous providers. */
  taskId: string;
  status: ImageJobStatus;
  /** Final URL — ours, not the provider's expiring one. Set once status is 'success'. */
  url?: string;
  /**
   * Storage key of the saved object, when it was saved. Absent for
   * `persist: false` jobs (there is no object) and for providers whose result
   * carries only a URL.
   */
  key?: string;
  error?: string;
  /**
   * The generation itself succeeded and the provider still hosts the file; only
   * the copy into our storage failed. Polling again is then a real retry rather
   * than a repeat of a failure, so callers should keep the job alive instead of
   * settling the parent task. Absent for genuine generation failures.
   */
  retryable?: boolean;
}

/**
 * Hosts whose URLs expire (Replicate/Fal) or point outside our storage. A
 * result still on one of these means persistence silently failed; callers
 * should treat it as an error rather than ship a link that 404s tomorrow.
 */
const UPSTREAM_HOSTS = [
  'replicate.delivery',
  'replicate.com',
  'fal.media',
  'fal.run',
  // Kie serves generated media from its own CDN and deletes it after 14 days.
  'kie.ai',
  'aiquickdraw.com',
  'generativelanguage.googleapis.com',
];

function isUpstreamUrl(url: string): boolean {
  try {
    const host = new URL(url).host;
    return UPSTREAM_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    // Relative URL (local dev fallback) — already ours.
    return false;
  }
}

/**
 * A storage-backed `saveFiles` that also remembers why it failed, and what it
 * stored.
 *
 * core/ai providers catch a saveFiles error, log it, and fall back to the
 * vendor's own expiring URL — deliberate, so one flaky upload can't kill a
 * whole generation, but it leaves callers able to report only "not persisted"
 * while the real reason (403 from the bucket, a failed download, …) stays
 * behind in the server log. Tracking it here lets the cause travel with the job
 * and reach the user.
 *
 * The keys are tracked for the same reason: providers copy only the URL back
 * into their result (see the Kie image path), so a caller that needs to delete
 * the object later — rather than guess at `0.png` — has no other way to learn
 * the key.
 */
function trackingSaveFiles(
  scope: string,
  slot: number
): {
  saveFiles: SaveFilesFunction;
  lastError: () => Error | null;
  lastKeys: () => string[];
} {
  let lastError: Error | null = null;
  let lastKeys: string[] = [];
  const inner = makeSaveFiles(scope, { index: slot });
  const saveFiles: SaveFilesFunction = async (files) => {
    try {
      const saved = await inner(files);
      if (saved) lastKeys = saved.map((f) => f.key).filter(Boolean);
      return saved;
    } catch (error: any) {
      lastError = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  };
  return { saveFiles, lastError: () => lastError, lastKeys: () => lastKeys };
}

/**
 * `saveFiles` for a job whose output deliberately stays on the provider's CDN.
 *
 * Handing the URLs straight back keeps the vendor link, so nothing is uploaded
 * — used when the caller consumes the bytes immediately (a PDF assembled at the
 * end of a generation) and would otherwise leave a permanent copy behind.
 */
const passThroughSaveFiles: SaveFilesFunction = async (files) =>
  files.filter((file) => Boolean(file?.url));

/**
 * Pick the saver for one job. `persist: false` deliberately swaps in the
 * pass-through, and every "the URL is still the vendor's" check below is
 * skipped for those jobs — a vendor URL there is the requested outcome, not a
 * failed upload.
 */
function jobSaveFiles(scope: string, slot: number, persist: boolean) {
  if (persist) return trackingSaveFiles(scope, slot);
  return {
    saveFiles: passThroughSaveFiles,
    lastError: () => null as Error | null,
    lastKeys: () => [] as string[],
  };
}

/** Explain a result that is still pointing at the provider instead of us. */
function notPersisted(lastError: Error | null): string {
  return lastError
    ? `generated image was not persisted to storage: ${lastError.message}`
    : 'generated image was not persisted to storage';
}

/** Thrown when an image is requested but no image provider is configured. */
export const NO_IMAGE_PROVIDER = 'No image provider configured';

/**
 * Reference images travel through `options.input` under whichever key the
 * selected model expects — there is no schema to consult, only the vendor docs.
 */
function buildImageOptions(
  configs: ConfigMap,
  model: string,
  referenceImages?: string[]
): Record<string, any> | undefined {
  if (!referenceImages?.length) return undefined;

  const field = resolveImageInputField(configs, model);
  return {
    input: {
      [field]: SINGLE_IMAGE_INPUT_FIELDS.has(field)
        ? referenceImages[0]
        : referenceImages,
    },
  };
}

/**
 * Kick off one illustration.
 *
 * Returns immediately for async providers (Replicate/Fal/Kie) with a taskId to
 * poll; for synchronous ones (Gemini) it returns 'success' with the stored URL
 * already filled in. Callers run the same polling loop either way — a job that
 * starts out 'success' simply never gets polled.
 *
 * `scope` + `slot` determine the storage key, so they must be stable across
 * the start and every later poll of the same job.
 *
 * `persist: false` leaves the finished image on the provider's CDN instead of
 * copying it into our storage. Only sensible when the caller is about to
 * consume the bytes and keep something derived from them — the URL expires.
 */
export async function startImageJob(params: {
  prompt: string;
  scope: string;
  slot: number;
  model?: string;
  /** Publicly reachable URLs of character photos to hold the likeness of. */
  referenceImages?: string[];
  persist?: boolean;
}): Promise<ImageJob> {
  const configs = await getAllConfigs();
  const provider = resolveImageProvider(configs);
  if (!provider) throw new Error(NO_IMAGE_PROVIDER);

  const model = params.model || getImageModel(configs, provider);
  const { prompt, scope, slot, referenceImages } = params;
  const persist = params.persist !== false;

  const saver = jobSaveFiles(scope, slot, persist);
  const manager = buildAIManager(configs, saver.saveFiles);
  const instance = manager.getProvider(provider);
  if (!instance) {
    throw new Error(`image provider not configured: ${provider}`);
  }

  const options = buildImageOptions(configs, model, referenceImages);

  const result = await instance.generate({
    params: {
      mediaType: AIMediaType.IMAGE,
      prompt,
      model,
      async: true,
      ...(options ? { options } : {}),
    },
  });

  if (
    result.taskStatus === AITaskStatus.FAILED ||
    result.taskStatus === AITaskStatus.CANCELED
  ) {
    return {
      provider,
      taskId: result.taskId,
      status: 'failed',
      error: result.taskInfo?.errorMessage || 'generation failed',
    };
  }

  if (result.taskStatus === AITaskStatus.SUCCESS) {
    // Gemini finishes inside generate() and hands back an already-stored URL.
    const url = result.taskInfo?.images?.[0]?.imageUrl;
    if (!url) {
      return {
        provider,
        taskId: result.taskId,
        status: 'failed',
        error: 'provider returned no image',
      };
    }
    if (persist && isUpstreamUrl(url)) {
      return {
        provider,
        taskId: result.taskId,
        status: 'failed',
        url,
        retryable: true,
        error: notPersisted(saver.lastError()),
      };
    }
    return {
      provider,
      taskId: result.taskId,
      status: 'success',
      url,
      key: saver.lastKeys()[0],
    };
  }

  return { provider, taskId: result.taskId, status: 'processing' };
}

/**
 * Check on an async job. Only meaningful for Replicate/Fal/Kie; polling a
 * synchronous provider's job is a no-op that replays its stored result.
 */
export async function pollImageJob(params: {
  provider: ImageProviderKind;
  taskId: string;
  scope: string;
  slot: number;
  model?: string;
  /** Must match the value the job was started with. See `startImageJob`. */
  persist?: boolean;
}): Promise<ImageJob> {
  const { provider, taskId, scope, slot } = params;
  if (!taskId) {
    throw new Error(`provider ${provider} has no pollable task`);
  }

  const configs = await getAllConfigs();
  const model = params.model || getImageModel(configs, provider);
  const persist = params.persist !== false;
  const saver = jobSaveFiles(scope, slot, persist);
  const manager = buildAIManager(configs, saver.saveFiles);
  const instance = manager.getProvider(provider);
  if (!instance?.query) {
    throw new Error(`image provider cannot be polled: ${provider}`);
  }

  const result = await instance.query({
    taskId,
    mediaType: AIMediaType.IMAGE,
    model,
  });

  if (result.taskStatus === AITaskStatus.PROCESSING) {
    return { provider, taskId, status: 'processing' };
  }
  if (result.taskStatus === AITaskStatus.PENDING) {
    return { provider, taskId, status: 'processing' };
  }
  if (result.taskStatus === AITaskStatus.CANCELED) {
    return { provider, taskId, status: 'failed', error: 'generation canceled' };
  }
  if (result.taskStatus === AITaskStatus.FAILED) {
    return {
      provider,
      taskId,
      status: 'failed',
      error: result.taskInfo?.errorMessage || 'generation failed',
    };
  }

  const url = result.taskInfo?.images?.[0]?.imageUrl;
  if (!url) {
    return {
      provider,
      taskId,
      status: 'failed',
      error: 'provider returned no image',
    };
  }
  if (persist && isUpstreamUrl(url)) {
    return {
      provider,
      taskId,
      status: 'failed',
      url,
      retryable: true,
      error: notPersisted(saver.lastError()),
    };
  }
  return {
    provider,
    taskId,
    status: 'success',
    url,
    key: saver.lastKeys()[0],
  };
}

// --- Text generation ------------------------------------------------------

export type TextGenerationResult = {
  provider: TextProviderKind;
  model: string;
  text: string;
};

/**
 * One-shot text completion over whichever chat API is configured.
 *
 * Returns null when no LLM is configured (`builtin`) — callers own the
 * offline fallback rather than being handed a fabricated response.
 */
export async function generateText(params: {
  system?: string;
  user: string;
  jsonMode?: boolean;
  maxTokens?: number;
}): Promise<TextGenerationResult | null> {
  const configs = await getAllConfigs();
  const provider = resolveTextProvider(configs);
  if (provider === 'builtin') return null;

  const model = getTextModel(configs, provider);
  const maxTokens = params.maxTokens ?? 4096;

  if (provider === 'kie') {
    // Kie's chat surface takes the model as a path segment rather than a body
    // field: `/api/v1/chat/completions` and `/v1/messages` both 404, only
    // `/{model}/v1/chat/completions` routes. The request and the successful
    // response are otherwise OpenAI-shaped.
    const resp = await fetch(
      `https://api.kie.ai/${encodeURIComponent(model)}/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${configs.kie_api_key}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            ...(params.system
              ? [{ role: 'system', content: params.system }]
              : []),
            { role: 'user', content: params.user },
          ],
          max_tokens: maxTokens,
          // No `response_format`: support is unverified, and callers already
          // salvage JSON out of a fenced/chatty reply.
        }),
        signal: AbortSignal.timeout(120_000),
      }
    );
    if (!resp.ok) {
      const detail = await resp.text();
      throw new Error(`kie request failed: ${resp.status} ${detail}`);
    }
    const data = await resp.json();
    // Kie reports failures inside an HTTP 200 envelope — an unsupported model
    // is `{"code":422,"msg":"The model is not supported"}` with status 200, so
    // `resp.ok` alone would treat it as success. A successful completion has no
    // `code` field at all, hence the one-sided check.
    if (data?.code !== undefined && data.code !== 200) {
      throw new Error(
        `kie request failed: ${data.code} ${data.msg || ''}`.trim()
      );
    }
    const text = String(data?.choices?.[0]?.message?.content ?? '').trim();
    if (!text) throw new Error('kie returned an empty response');
    return { provider, model, text };
  }

  if (provider === 'anthropic') {
    const baseUrl = (
      configs.anthropic_base_url || 'https://api.anthropic.com'
    ).replace(/\/+$/, '');
    const resp = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': configs.anthropic_api_key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        ...(params.system ? { system: params.system } : {}),
        messages: [{ role: 'user', content: params.user }],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!resp.ok) {
      const detail = await resp.text();
      throw new Error(`anthropic request failed: ${resp.status} ${detail}`);
    }
    const data = await resp.json();
    const text = Array.isArray(data?.content)
      ? data.content
          .map((block: any) => block?.text || '')
          .join('')
          .trim()
      : '';
    if (!text) throw new Error('anthropic returned an empty response');
    return { provider, model, text };
  }

  const baseUrl = (
    configs.openai_base_url || 'https://api.openai.com/v1'
  ).replace(/\/+$/, '');
  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${configs.openai_api_key}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        ...(params.system ? [{ role: 'system', content: params.system }] : []),
        { role: 'user', content: params.user },
      ],
      max_tokens: maxTokens,
      ...(params.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`openai request failed: ${resp.status} ${detail}`);
  }
  const data = await resp.json();
  const text = String(data?.choices?.[0]?.message?.content ?? '').trim();
  if (!text) throw new Error('openai returned an empty response');
  return { provider, model, text };
}
