import {
  AIConfigs,
  AIFile,
  AIGenerateParams,
  AIImage,
  AIMediaType,
  AIProvider,
  AITaskResult,
  AITaskStatus,
  AIVideo,
  SaveFilesFunction,
  UuidFunction,
} from './types';

const defaultUuid: UuidFunction = () => crypto.randomUUID();

/**
 * Fal configs
 * @docs https://fal.ai/
 */
export interface FalConfigs extends AIConfigs {
  apiKey: string;
  customStorage?: boolean;
  saveFiles?: SaveFilesFunction;
  uuid?: UuidFunction;
}

/**
 * Fal provider
 * @docs https://fal.ai/
 */
export class FalProvider implements AIProvider {
  readonly name = 'fal';
  configs: FalConfigs;

  private baseUrl = 'https://queue.fal.run';

  constructor(configs: FalConfigs) {
    this.configs = configs;
  }

  private getUuid(): string {
    return (this.configs.uuid || defaultUuid)();
  }

  private async trySaveFiles(files: AIFile[]): Promise<AIFile[] | undefined> {
    if (!this.configs.saveFiles) return undefined;
    try {
      return await this.configs.saveFiles(files);
    } catch (error) {
      console.error('save files failed:', error);
      return undefined;
    }
  }

  async generate({
    params,
  }: {
    params: AIGenerateParams;
  }): Promise<AITaskResult> {
    const { mediaType, model, prompt, options, callbackUrl } = params;

    if (!mediaType) {
      throw new Error('mediaType is required');
    }

    if (!model) {
      throw new Error('model is required');
    }

    if (!prompt) {
      throw new Error('prompt is required');
    }

    const input = this.formatInput({ mediaType, model, prompt, options });

    let apiUrl = `${this.baseUrl}/${model}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Key ${this.configs.apiKey}`,
    };

    const isValidCallbackUrl =
      callbackUrl &&
      callbackUrl.startsWith('http') &&
      !callbackUrl.includes('localhost') &&
      !callbackUrl.includes('127.0.0.1');

    if (isValidCallbackUrl) {
      apiUrl += `?fal_webhook=${callbackUrl}`;
    }

    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
    });

    if (!resp.ok) {
      throw new Error(`request failed with status: ${resp.status}`);
    }

    const data = await resp.json();

    if (!data || !data.request_id) {
      throw new Error('generate failed: no request_id');
    }

    return {
      taskStatus: AITaskStatus.PENDING,
      taskId: data.request_id,
      taskInfo: {},
      taskResult: data,
    };
  }

  async query({
    taskId,
    model,
    mediaType,
  }: {
    taskId: string;
    model?: string;
    mediaType?: AIMediaType;
  }): Promise<AITaskResult> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Key ${this.configs.apiKey}`,
    };

    const { queryModel, statusData } = await this.queryStatus({
      taskId,
      model,
      headers,
    });

    const taskStatus = this.mapStatus(statusData.status);

    if (taskStatus !== AITaskStatus.SUCCESS) {
      return {
        taskId,
        taskStatus,
        taskInfo: {
          status: statusData.status,
          errorCode: '',
          errorMessage: '',
        },
        taskResult: statusData,
      };
    }

    const resultResp = await fetch(
      `${this.baseUrl}/${queryModel}/requests/${taskId}`,
      { method: 'GET', headers }
    );

    if (!resultResp.ok) {
      throw new Error(`request failed with status: ${resultResp.status}`);
    }

    const raw = await resultResp.json();

    let images: AIImage[] | undefined = undefined;
    let videos: AIVideo[] | undefined = undefined;

    if (mediaType === AIMediaType.VIDEO) {
      if (raw.video && raw.video.url) {
        videos = [
          {
            id: '',
            createTime: new Date(),
            videoUrl: raw.video.url,
          },
        ];
      } else if (raw.videos && Array.isArray(raw.videos)) {
        videos = raw.videos.map((video: any) => ({
          id: '',
          createTime: new Date(),
          videoUrl: video.url,
        }));
      }
    } else {
      if (raw.images && Array.isArray(raw.images)) {
        images = raw.images.map((image: any) => ({
          id: '',
          createTime: new Date(),
          imageUrl: image.url,
        }));
      }
    }

    if (this.configs.customStorage) {
      if (images && images.length > 0) {
        const filesToSave: AIFile[] = [];
        images.forEach((image, index) => {
          if (image.imageUrl) {
            filesToSave.push({
              url: image.imageUrl,
              contentType: 'image/png',
              key: `fal/image/${this.getUuid()}.png`,
              index: index,
              type: 'image',
            });
          }
        });

        if (filesToSave.length > 0) {
          const uploadedFiles = await this.trySaveFiles(filesToSave);
          if (uploadedFiles) {
            uploadedFiles.forEach((file: AIFile) => {
              if (file && file.url && images && file.index !== undefined) {
                const image = images[file.index];
                if (image) {
                  image.imageUrl = file.url;
                }
              }
            });
          }
        }
      }

      if (videos && videos.length > 0) {
        const filesToSave: AIFile[] = [];
        videos.forEach((video, index) => {
          if (video.videoUrl) {
            filesToSave.push({
              url: video.videoUrl,
              contentType: 'video/mp4',
              key: `fal/video/${this.getUuid()}.mp4`,
              index: index,
              type: 'video',
            });
          }
        });

        if (filesToSave.length > 0) {
          const uploadedFiles = await this.trySaveFiles(filesToSave);
          if (uploadedFiles) {
            uploadedFiles.forEach((file: AIFile) => {
              if (file && file.url && videos && file.index !== undefined) {
                const video = videos[file.index];
                if (video) {
                  video.videoUrl = file.url;
                }
              }
            });
          }
        }
      }
    }

    return {
      taskId,
      taskStatus,
      taskInfo: {
        images,
        videos,
        status: statusData.status,
        errorCode: '',
        errorMessage: '',
        createTime: new Date(),
      },
      taskResult: raw,
    };
  }

  /**
   * Fetch a request's status, settling which path it lives under.
   *
   * A request is *submitted* to the full endpoint id (`fal-ai/nano-banana/edit`)
   * but read back from the app: fal's own client rebuilds status/result URLs as
   * `owner/alias` and drops everything after it, so `fal-ai/nano-banana/edit`
   * is polled at `fal-ai/nano-banana/requests/{id}/status`. Try that first; a
   * 404 falls back to the full path in case an endpoint ever needs it.
   */
  private async queryStatus({
    taskId,
    model,
    headers,
  }: {
    taskId: string;
    model?: string;
    headers: Record<string, string>;
  }): Promise<{ queryModel: string; statusData: any }> {
    if (!model) {
      throw new Error('model is required to query a request');
    }

    const candidates = [this.getQueryModel(model), model].filter(
      (candidate, i, all) => candidate && all.indexOf(candidate) === i
    );

    for (const candidate of candidates) {
      const resp = await fetch(
        `${this.baseUrl}/${candidate}/requests/${taskId}/status`,
        { method: 'GET', headers }
      );
      if (resp.ok) {
        return { queryModel: candidate, statusData: await resp.json() };
      }
      // Only a 404 means "wrong path" — anything else is a real failure and
      // retrying it under another path would just hide it.
      if (resp.status !== 404) {
        throw new Error(`request failed with status: ${resp.status}`);
      }
    }

    throw new Error(`request failed with status: 404`);
  }

  private mapStatus(status: string): AITaskStatus {
    switch (status) {
      case 'IN_QUEUE':
        return AITaskStatus.PENDING;
      case 'IN_PROGRESS':
        return AITaskStatus.PROCESSING;
      case 'COMPLETED':
        return AITaskStatus.SUCCESS;
      case 'FAILED':
        return AITaskStatus.FAILED;
      default:
        throw new Error(`unknown status: ${status}`);
    }
  }

  private getQueryModel(model?: string): string {
    if (!model) {
      return '';
    }
    const parts = model.split('/');
    if (parts.length <= 2) {
      return model;
    }
    return `${parts[0]}/${parts[1]}`;
  }

  private formatInput({
    mediaType,
    model,
    prompt,
    options,
  }: {
    mediaType: AIMediaType;
    model: string;
    prompt: string;
    options: any;
  }): any {
    let input: any = { prompt };

    if (!options) {
      return input;
    }

    input = { ...input, ...options };

    // Unwrap an `input` object into the top level.
    //
    // The image module builds reference-image params in the envelope shape the
    // Kie provider needs (`{ input: { image_urls: [...] } }`). Fal takes the
    // model's own input fields at the top of the body instead, so passing that
    // envelope through would ship a stray `input` key the endpoint does not
    // know — and the reference images would be dropped without an error.
    if (
      options.input &&
      typeof options.input === 'object' &&
      !Array.isArray(options.input)
    ) {
      Object.assign(input, options.input);
      delete input.input;
      // Re-asserted: `options.input` must not be able to clobber the prompt.
      input.prompt = prompt;
    }

    if (options.image_input && Array.isArray(options.image_input)) {
      if (['fal-ai/kling-video/o1/video-to-video/edit'].includes(model)) {
        input.input_images = options.image_input;
      } else {
        input.image_url = options.image_input[0];
      }
      delete input.image_input;
    }

    if (options.video_input && Array.isArray(options.video_input)) {
      input.video_url = options.video_input[0];
      delete input.video_input;
    }

    return input;
  }
}
