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
   * Optional maximum total time to wait for a prediction in milliseconds.
   * No default: without it, polling continues until the task reaches a
   * terminal status (or the caller aborts via `abortSignal`).
   */
  pollTimeoutMillis?: number;
  _internal?: {
    currentDate?: () => Date;
    /** Backoff unit for transient poll failures. Defaults to 1000. */
    pollErrorBackoffMillis?: number;
    /** Per-HTTP-request timeout (submit and each poll). Defaults to 120000. */
    requestTimeoutMillis?: number;
  };
};

export const DEFAULT_POLL_INTERVAL_MILLIS = 1000;
export const DEFAULT_REQUEST_TIMEOUT_MILLIS = 120000;
