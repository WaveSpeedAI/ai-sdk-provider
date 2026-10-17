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
  DEFAULT_POLL_REQUEST_TIMEOUT_MILLIS,
  DEFAULT_SUBMIT_REQUEST_TIMEOUT_MILLIS,
  type WaveSpeedConfig,
} from './wavespeed-config';
import {
  asNonRetryable,
  getWithPollRetry,
  withRequestTimeout,
  waveSpeedFailedResponseHandler,
} from './wavespeed-error';
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

    // Submit the prediction. Single-shot: a failed submit may still have
    // created a paid task, so it must never be retried by the AI SDK.
    const submitUrl = `${this.config.baseURL}/api/v3/${this.modelId}`;
    const { value: submitResponse } = await withRequestTimeout(
      signal =>
        postJsonToApi({
          url: submitUrl,
          headers,
          body,
          failedResponseHandler: waveSpeedFailedResponseHandler,
          successfulResponseHandler: createJsonResponseHandler(
            waveSpeedSubmitResponseSchema,
          ),
          abortSignal: signal,
          fetch: this.config.fetch,
        }),
      {
        abortSignal: options.abortSignal,
        timeoutMillis:
          this.config._internal?.requestTimeoutMillis ??
          DEFAULT_SUBMIT_REQUEST_TIMEOUT_MILLIS,
        url: submitUrl,
      },
    ).catch(error => {
      throw asNonRetryable(error);
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
    // No overall cap unless the caller opts in with pollTimeoutMillis.
    const pollTimeoutMillis = this.config.pollTimeoutMillis;
    const deadline =
      pollTimeoutMillis != null ? Date.now() + pollTimeoutMillis : undefined;
    const url = `${this.config.baseURL}/api/v3/predictions/${predictionId}/result`;

    for (;;) {
      const { value: result, responseHeaders } = await getWithPollRetry(
        () =>
          withRequestTimeout(
            signal =>
              getFromApi({
                url,
                headers,
                failedResponseHandler: waveSpeedFailedResponseHandler,
                successfulResponseHandler: createJsonResponseHandler(
                  waveSpeedResultResponseSchema,
                ),
                abortSignal: signal,
                fetch: this.config.fetch,
              }),
            {
              abortSignal,
              timeoutMillis:
                this.config._internal?.requestTimeoutMillis ??
                DEFAULT_POLL_REQUEST_TIMEOUT_MILLIS,
              url,
            },
          ),
        {
          predictionId,
          backoffMillis: this.config._internal?.pollErrorBackoffMillis,
          abortSignal,
        },
      );

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

      if (deadline != null && Date.now() >= deadline) {
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

      await delay(pollIntervalMillis, { abortSignal });
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
    }).catch(error => {
      // The prediction already exists (and is charged): a retryable error here
      // would make the AI SDK re-run doGenerate and submit a second task.
      throw asNonRetryable(error);
    });
    return response;
  }
}
