import {
  NoSuchModelError,
  type Experimental_VideoModelV4,
  type ImageModelV4,
  type ProviderV4,
} from '@ai-sdk/provider';
import {
  loadApiKey,
  withoutTrailingSlash,
  withUserAgentSuffix,
  type FetchFunction,
} from '@ai-sdk/provider-utils';
import { WaveSpeedImageModel } from './wavespeed-image-model';
import { WaveSpeedVideoModel } from './wavespeed-video-model';
import { VERSION } from './version';

export interface WaveSpeedProviderSettings {
  /**
   * WaveSpeed API key. Default value is taken from the `WAVESPEED_API_KEY`
   * environment variable.
   */
  apiKey?: string;

  /**
   * Base URL for the API calls.
   * The default prefix is `https://api.wavespeed.ai`.
   */
  baseURL?: string;

  /**
   * Custom headers to include in the requests.
   */
  headers?: Record<string, string>;

  /**
   * Custom fetch implementation. You can use it as a middleware to intercept
   * requests, or to provide a custom fetch implementation for e.g. testing.
   */
  fetch?: FetchFunction;

  /**
   * Interval between prediction poll requests in milliseconds.
   * Defaults to 1000.
   */
  pollIntervalMillis?: number;

  /**
   * Maximum total time to wait for a prediction in milliseconds.
   * Defaults to 600000 (10 minutes).
   */
  pollTimeoutMillis?: number;
}

export interface WaveSpeedProvider extends ProviderV4 {
  /**
   * Creates a model for image generation.
   */
  image(modelId: string): ImageModelV4;

  /**
   * Creates a model for image generation.
   */
  imageModel(modelId: string): ImageModelV4;

  /**
   * Creates a model for video generation.
   */
  video(modelId: string): Experimental_VideoModelV4;

  /**
   * Creates a model for video generation.
   */
  videoModel(modelId: string): Experimental_VideoModelV4;

  /**
   * @deprecated Use `embeddingModel` instead.
   */
  textEmbeddingModel(modelId: string): never;
}

const defaultBaseURL = 'https://api.wavespeed.ai';

/**
 * Lowercase OS name for the X-Client-OS header: darwin / linux / windows
 * (win32 is reported as windows). Falls back to user agent parsing in
 * browser environments, and 'unknown' elsewhere (e.g. edge runtimes).
 */
function getOperatingSystem(): string {
  if (typeof process !== 'undefined' && process.platform) {
    return process.platform === 'win32' ? 'windows' : process.platform;
  }
  if (typeof navigator !== 'undefined' && navigator.userAgent) {
    const userAgent = navigator.userAgent.toLowerCase();
    if (userAgent.includes('mac os x') || userAgent.includes('macintosh')) {
      return 'darwin';
    }
    if (
      userAgent.includes('windows') ||
      userAgent.includes('win64') ||
      userAgent.includes('win32')
    ) {
      return 'windows';
    }
    if (userAgent.includes('android')) {
      return 'android';
    }
    if (
      userAgent.includes('iphone') ||
      userAgent.includes('ipad') ||
      userAgent.includes('ipod')
    ) {
      return 'ios';
    }
    if (userAgent.includes('linux')) {
      return 'linux';
    }
  }
  return 'unknown';
}

/**
 * Channel-attribution headers (X-Client-Name / X-Client-Version /
 * X-Client-OS), following the wavespeed-desktop convention. The
 * WAVESPEED_CLIENT_NAME environment variable overrides the name so wrapper
 * channels can brand themselves without code changes. These defaults are
 * merged under user-supplied headers, so custom headers always win.
 */
function clientAttributionHeaders(): Record<string, string> {
  const envClientName =
    typeof process !== 'undefined' && process.env
      ? process.env.WAVESPEED_CLIENT_NAME
      : undefined;
  return {
    'X-Client-Name': envClientName || 'wavespeed-ai-sdk-provider',
    'X-Client-Version': VERSION,
    'X-Client-OS': getOperatingSystem(),
  };
}

/**
 * Create a WaveSpeed provider instance.
 */
export function createWaveSpeed(
  options: WaveSpeedProviderSettings = {},
): WaveSpeedProvider {
  const baseURL =
    withoutTrailingSlash(options.baseURL ?? defaultBaseURL) ?? defaultBaseURL;

  const getHeaders = () =>
    withUserAgentSuffix(
      {
        Authorization: `Bearer ${loadApiKey({
          apiKey: options.apiKey,
          environmentVariableName: 'WAVESPEED_API_KEY',
          description: 'WaveSpeed',
        })}`,
        ...clientAttributionHeaders(),
        ...options.headers,
      },
      `wavespeed/ai-sdk-provider/${VERSION}`,
    );

  const createImageModel = (modelId: string) =>
    new WaveSpeedImageModel(modelId, {
      provider: 'wavespeed.image',
      baseURL,
      headers: getHeaders,
      fetch: options.fetch,
      pollIntervalMillis: options.pollIntervalMillis,
      pollTimeoutMillis: options.pollTimeoutMillis,
    });

  const createVideoModel = (modelId: string) =>
    new WaveSpeedVideoModel(modelId, {
      provider: 'wavespeed.video',
      baseURL,
      headers: getHeaders,
      fetch: options.fetch,
      pollIntervalMillis: options.pollIntervalMillis,
      pollTimeoutMillis: options.pollTimeoutMillis,
    });

  const embeddingModel = (modelId: string) => {
    throw new NoSuchModelError({ modelId, modelType: 'embeddingModel' });
  };

  return {
    specificationVersion: 'v4' as const,
    image: createImageModel,
    imageModel: createImageModel,
    video: createVideoModel,
    videoModel: createVideoModel,
    languageModel: (modelId: string) => {
      throw new NoSuchModelError({ modelId, modelType: 'languageModel' });
    },
    embeddingModel,
    textEmbeddingModel: embeddingModel,
  };
}

/**
 * Default WaveSpeed provider instance.
 */
export const wavespeed = createWaveSpeed();
