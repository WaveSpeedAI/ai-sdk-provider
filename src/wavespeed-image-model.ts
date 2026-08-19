import type { ImageModelV4, SharedV4Warning } from '@ai-sdk/provider';
import { APICallError } from '@ai-sdk/provider';
import {
  combineHeaders,
  convertImageModelFileToDataUri,
  createBinaryResponseHandler,
  createJsonResponseHandler,
  createStatusCodeErrorResponseHandler,
  delay,
  getFromApi,
  postJsonToApi,
  resolve,
  serializeModelOptions,
  WORKFLOW_SERIALIZE,
  WORKFLOW_DESERIALIZE,
} from '@ai-sdk/provider-utils';
import {
  DEFAULT_POLL_INTERVAL_MILLIS,
  DEFAULT_POLL_TIMEOUT_MILLIS,
  type WaveSpeedConfig,
} from './wavespeed-config';
import { waveSpeedFailedResponseHandler } from './wavespeed-error';
import {
  isTerminalFailure,
  waveSpeedResultResponseSchema,
  waveSpeedSubmitResponseSchema,
  type WaveSpeedResultResponse,
} from './wavespeed-api';

export class WaveSpeedImageModel implements ImageModelV4 {
  readonly specificationVersion = 'v4';
  readonly maxImagesPerCall = 1;

  get provider(): string {
    return this.config.provider;
  }

  static [WORKFLOW_SERIALIZE](model: WaveSpeedImageModel) {
    return serializeModelOptions({
      modelId: model.modelId,
      config: model.config,
    });
  }

  static [WORKFLOW_DESERIALIZE](options: {
    modelId: string;
    config: WaveSpeedConfig;
  }) {
    return new WaveSpeedImageModel(options.modelId, options.config);
  }

  constructor(
    readonly modelId: string,
    private readonly config: WaveSpeedConfig,
  ) {}

  private getArgs({
    prompt,
    n,
    size,
    aspectRatio,
    seed,
    providerOptions,
    files,
    mask,
  }: Parameters<ImageModelV4['doGenerate']>[0]) {
    const warnings: Array<SharedV4Warning> = [];

    const body: Record<string, unknown> = {};

    if (prompt != null) {
      body.prompt = prompt;
    }

    if (size != null) {
      // WaveSpeed uses `size` in the `{width}*{height}` format.
      body.size = size.replace('x', '*');
    }

    if (aspectRatio != null) {
      body.aspect_ratio = aspectRatio;
    }

    if (seed != null) {
      body.seed = seed;
    }

    if (n != null && n > 1) {
      warnings.push({
        type: 'unsupported',
        feature: 'n',
        details:
          'WaveSpeed generates one image per call by default. ' +
          'If the model supports batching, pass the model-specific field ' +
          "(e.g. 'num_images' or 'max_images') via providerOptions.wavespeed.",
      });
    }

    if (files != null && files.length > 0) {
      const toUri = (file: NonNullable<typeof files>[number]) =>
        file.type === 'url' ? file.url : convertImageModelFileToDataUri(file);

      if (files.length === 1) {
        body.image = toUri(files[0]!);
      } else {
        body.images = files.map(toUri);
      }
    }

    if (mask != null) {
      body.mask_image =
        mask.type === 'url' ? mask.url : convertImageModelFileToDataUri(mask);
    }

    // Provider-specific passthrough. Values sent here win over mapped args.
    const passthrough = providerOptions?.wavespeed;
    if (passthrough != null) {
      for (const [key, value] of Object.entries(passthrough)) {
        if (value !== undefined) {
          body[key] = value;
        }
      }
    }

    return { body, warnings } as const;
  }

  async doGenerate(
    options: Parameters<ImageModelV4['doGenerate']>[0],
  ): Promise<Awaited<ReturnType<ImageModelV4['doGenerate']>>> {
    const { body, warnings } = this.getArgs(options);
    const currentDate = this.config._internal?.currentDate?.() ?? new Date();

    const headers = combineHeaders(
      this.config.headers ? await resolve(this.config.headers) : undefined,
      options.headers,
    );

    // Submit the prediction.
    const { value: submitResponse } = await postJsonToApi({
      url: `${this.config.baseURL}/api/v3/${this.modelId}`,
      headers,
      body,
      failedResponseHandler: waveSpeedFailedResponseHandler,
      successfulResponseHandler: createJsonResponseHandler(
        waveSpeedSubmitResponseSchema,
      ),
      abortSignal: options.abortSignal,
      fetch: this.config.fetch,
    });

    const predictionId = submitResponse.data.id;

    // Poll until the prediction reaches a terminal status.
    const { result, responseHeaders } = await this.pollUntilDone({
      predictionId,
      headers,
      abortSignal: options.abortSignal,
    });

    const outputs = result.data.outputs ?? [];

    // Download the generated images.
    const images = await Promise.all(
      outputs.map(url => this.downloadImage(url, options.abortSignal)),
    );

    const { outputs: _outputs, ...resultMetadata } = result.data;

    return {
      images,
      warnings,
      response: {
        timestamp: currentDate,
        modelId: this.modelId,
        headers: responseHeaders,
      },
      providerMetadata: {
        wavespeed: {
          images: outputs.map(url => ({ url })),
          ...resultMetadata,
        },
      },
    };
  }

  private async pollUntilDone({
    predictionId,
    headers,
    abortSignal,
  }: {
    predictionId: string;
    headers: Record<string, string | undefined>;
    abortSignal: AbortSignal | undefined;
  }): Promise<{
    result: WaveSpeedResultResponse;
    responseHeaders: Record<string, string> | undefined;
  }> {
    const pollIntervalMillis =
      this.config.pollIntervalMillis ?? DEFAULT_POLL_INTERVAL_MILLIS;
    const pollTimeoutMillis =
      this.config.pollTimeoutMillis ?? DEFAULT_POLL_TIMEOUT_MILLIS;
    const deadline = Date.now() + pollTimeoutMillis;
    const url = `${this.config.baseURL}/api/v3/predictions/${predictionId}/result`;

    for (;;) {
      const { value: result, responseHeaders } = await getFromApi({
        url,
        headers,
        failedResponseHandler: waveSpeedFailedResponseHandler,
        successfulResponseHandler: createJsonResponseHandler(
          waveSpeedResultResponseSchema,
        ),
        abortSignal,
        fetch: this.config.fetch,
      });

      const { status, error } = result.data;

      if (status === 'completed') {
        return { result, responseHeaders };
      }

      if (isTerminalFailure(status)) {
        throw new APICallError({
          message: `WaveSpeed prediction ${status}${
            error ? `: ${error}` : ''
          } (prediction id: ${predictionId})`,
          url,
          requestBodyValues: {},
          responseHeaders,
          data: result.data,
          isRetryable: false,
        });
      }

      if (Date.now() >= deadline) {
        throw new APICallError({
          message:
            `WaveSpeed prediction still '${status}' after ${pollTimeoutMillis}ms ` +
            `(prediction id: ${predictionId}). The task keeps running server-side.`,
          url,
          requestBodyValues: {},
          responseHeaders,
          data: result.data,
          isRetryable: false,
        });
      }

      await delay(pollIntervalMillis);
    }
  }

  private async downloadImage(
    url: string,
    abortSignal: AbortSignal | undefined,
  ): Promise<Uint8Array> {
    const { value: response } = await getFromApi({
      url,
      // url is a generated-image URL from the prediction result; validate it.
      validateUrl: true,
      trustedOrigin: this.config.baseURL,
      abortSignal,
      failedResponseHandler: createStatusCodeErrorResponseHandler(),
      successfulResponseHandler: createBinaryResponseHandler(),
      fetch: this.config.fetch,
    });
    return response;
  }
}
