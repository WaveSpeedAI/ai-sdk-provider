import type {
  Experimental_VideoModelV4 as VideoModelV4,
  Experimental_VideoModelV4OperationStartResult as VideoModelV4OperationStartResult,
  Experimental_VideoModelV4OperationStatusResult as VideoModelV4OperationStatusResult,
  SharedV4Warning,
} from '@ai-sdk/provider';
import { APICallError } from '@ai-sdk/provider';
import {
  combineHeaders,
  convertImageModelFileToDataUri,
  createJsonResponseHandler,
  getFromApi,
  postJsonToApi,
  resolve,
  serializeModelOptions,
  WORKFLOW_SERIALIZE,
  WORKFLOW_DESERIALIZE,
} from '@ai-sdk/provider-utils';
import type { WaveSpeedConfig } from './wavespeed-config';
import { waveSpeedFailedResponseHandler } from './wavespeed-error';
import {
  isTerminalFailure,
  waveSpeedResultResponseSchema,
  waveSpeedSubmitResponseSchema,
} from './wavespeed-api';

export class WaveSpeedVideoModel implements VideoModelV4 {
  readonly specificationVersion = 'v4';
  readonly maxVideosPerCall = 1;

  get provider(): string {
    return this.config.provider;
  }

  static [WORKFLOW_SERIALIZE](model: WaveSpeedVideoModel) {
    return serializeModelOptions({
      modelId: model.modelId,
      config: model.config,
    });
  }

  static [WORKFLOW_DESERIALIZE](options: {
    modelId: string;
    config: WaveSpeedConfig;
  }) {
    return new WaveSpeedVideoModel(options.modelId, options.config);
  }

  constructor(
    readonly modelId: string,
    private readonly config: WaveSpeedConfig,
  ) {}

  private buildRequestBody(
    options: Parameters<NonNullable<VideoModelV4['doStart']>>[0],
  ): { body: Record<string, unknown>; warnings: SharedV4Warning[] } {
    const warnings: SharedV4Warning[] = [];
    const body: Record<string, unknown> = {};

    if (options.prompt != null) {
      body.prompt = options.prompt;
    }

    if (options.image != null) {
      body.image =
        options.image.type === 'url'
          ? options.image.url
          : convertImageModelFileToDataUri(options.image);
    }

    if (options.aspectRatio != null) {
      body.aspect_ratio = options.aspectRatio;
    }

    if (options.resolution != null) {
      body.resolution = options.resolution;
    }

    if (options.duration != null) {
      body.duration = options.duration;
    }

    if (options.fps != null) {
      body.fps = options.fps;
    }

    if (options.seed != null) {
      body.seed = options.seed;
    }

    if (options.generateAudio != null) {
      body.generate_audio = options.generateAudio;
    }

    if (options.n != null && options.n > 1) {
      warnings.push({
        type: 'unsupported',
        feature: 'n',
        details: 'WaveSpeed video models generate one video per call.',
      });
    }

    if (options.frameImages != null && options.frameImages.length > 0) {
      warnings.push({
        type: 'unsupported',
        feature: 'frameImages',
        details:
          'Pass first/last frame images via providerOptions.wavespeed using ' +
          'the model-specific field names instead.',
      });
    }

    if (options.inputReferences != null && options.inputReferences.length > 0) {
      warnings.push({
        type: 'unsupported',
        feature: 'inputReferences',
        details:
          'Pass reference inputs via providerOptions.wavespeed using the ' +
          'model-specific field names instead.',
      });
    }

    // Provider-specific passthrough. Values sent here win over mapped args.
    const passthrough = options.providerOptions?.wavespeed;
    if (passthrough != null) {
      for (const [key, value] of Object.entries(passthrough)) {
        if (value !== undefined) {
          body[key] = value;
        }
      }
    }

    return { body, warnings };
  }

  async doStart(
    options: Parameters<NonNullable<VideoModelV4['doStart']>>[0],
  ): Promise<VideoModelV4OperationStartResult> {
    const currentDate = this.config._internal?.currentDate?.() ?? new Date();
    const { body, warnings } = this.buildRequestBody(options);

    const { value: submitResponse, responseHeaders } = await postJsonToApi({
      url: `${this.config.baseURL}/api/v3/${this.modelId}`,
      headers: combineHeaders(
        this.config.headers ? await resolve(this.config.headers) : undefined,
        options.headers,
      ),
      body,
      failedResponseHandler: waveSpeedFailedResponseHandler,
      successfulResponseHandler: createJsonResponseHandler(
        waveSpeedSubmitResponseSchema,
      ),
      abortSignal: options.abortSignal,
      fetch: this.config.fetch,
    });

    return {
      operation: { predictionId: submitResponse.data.id },
      warnings,
      response: {
        timestamp: currentDate,
        modelId: this.modelId,
        headers: responseHeaders,
      },
    };
  }

  async doStatus(
    options: Parameters<NonNullable<VideoModelV4['doStatus']>>[0],
  ): Promise<VideoModelV4OperationStatusResult> {
    const currentDate = this.config._internal?.currentDate?.() ?? new Date();
    const { predictionId } = options.operation as { predictionId: string };
    const url = `${this.config.baseURL}/api/v3/predictions/${predictionId}/result`;

    try {
      const { value: result, responseHeaders } = await getFromApi({
        url,
        headers: combineHeaders(
          this.config.headers ? await resolve(this.config.headers) : undefined,
          options.headers,
        ),
        failedResponseHandler: waveSpeedFailedResponseHandler,
        successfulResponseHandler: createJsonResponseHandler(
          waveSpeedResultResponseSchema,
        ),
        abortSignal: options.abortSignal,
        fetch: this.config.fetch,
      });

      const { status, error, outputs } = result.data;

      if (status === 'completed') {
        const urls = outputs ?? [];
        const { outputs: _outputs, ...resultMetadata } = result.data;

        return {
          status: 'completed',
          videos: urls.map(videoUrl => ({
            type: 'url' as const,
            url: videoUrl,
            mediaType: 'video/mp4',
          })),
          warnings: [],
          providerMetadata: {
            wavespeed: {
              videos: urls.map(videoUrl => ({ url: videoUrl })),
              ...resultMetadata,
            },
          },
          response: {
            timestamp: currentDate,
            modelId: this.modelId,
            headers: responseHeaders,
          },
        };
      }

      if (isTerminalFailure(status)) {
        return {
          status: 'error',
          error: `WaveSpeed prediction ${status}${
            error ? `: ${error}` : ''
          } (prediction id: ${predictionId})`,
          response: {
            timestamp: currentDate,
            modelId: this.modelId,
            headers: responseHeaders,
          },
        };
      }

      return {
        status: 'pending',
        response: {
          timestamp: currentDate,
          modelId: this.modelId,
          headers: responseHeaders,
        },
      };
    } catch (error) {
      if (APICallError.isInstance(error)) {
        return {
          status: 'error',
          error: error.message,
          response: {
            timestamp: currentDate,
            modelId: this.modelId,
            headers: error.responseHeaders,
          },
        };
      }
      throw error;
    }
  }
}
