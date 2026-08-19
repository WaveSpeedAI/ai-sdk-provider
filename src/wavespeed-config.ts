import type { FetchFunction, Resolvable } from '@ai-sdk/provider-utils';

export type WaveSpeedConfig = {
  provider: string;
  baseURL: string;
  headers?: Resolvable<Record<string, string | undefined>>;
  fetch?: FetchFunction;
  /**
   * Interval between poll requests in milliseconds. Defaults to 1000.
   */
  pollIntervalMillis?: number;
  /**
   * Maximum total time to wait for a prediction in milliseconds.
   * Defaults to 600000 (10 minutes).
   */
  pollTimeoutMillis?: number;
  _internal?: {
    currentDate?: () => Date;
  };
};

export const DEFAULT_POLL_INTERVAL_MILLIS = 1000;
export const DEFAULT_POLL_TIMEOUT_MILLIS = 600000;
