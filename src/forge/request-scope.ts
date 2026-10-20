import { t } from "./locale";
/** Local waiting is bounded; aborting a request does not undo remote work. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_INFERENCE_TIMEOUT_MS = 120_000;

export class RequestTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(t("Request timed out after {0}ms. Remote work may still be running; inspect its status before retrying.", timeoutMs));
    this.name = "RequestTimeoutError";
  }
}

export function positiveTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
    throw new RangeError(t("timeoutMs must be a finite positive number no greater than 2147483647"));
  }
  return value;
}

/** Settle even when an injected implementation ignores the signal. */
export function waitWithAbort<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => { cleanup(); reject(signal.reason ?? new Error(t("Request aborted"))); };
    pending.then(value => {
      cleanup();
      if (signal.aborted) abort(); else resolve(value);
    }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

export interface RequestScope {
  readonly signal: AbortSignal;
  wait<T>(pending: Promise<T>): Promise<T>;
  dispose(): void;
  streamResponse<T extends { body?: any }>(response: T): T;
}

export function requestScope(options: { timeoutMs?: number; signal?: AbortSignal } = {}): RequestScope {
  const timeoutMs = positiveTimeout(options.timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  const controller = new AbortController();
  const abort = () => { controller.abort(options.signal?.reason); dispose(); };
  const timer = setTimeout(() => { controller.abort(new RequestTimeoutError(timeoutMs)); dispose(); }, timeoutMs);
  timer.unref?.();
  function dispose() { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    wait: pending => waitWithAbort(pending, controller.signal),
    dispose,
    streamResponse(response) {
      // A healthy SSE subscription owns its lifetime after bounded headers.
      // Keep caller cancellation until EOF/cancel; do not expire it like JSON.
      clearTimeout(timer);
      if (!response.body || typeof response.body.getReader !== "function") { dispose(); return response; }
      const body = response.body;
      const wrapped = { getReader(...args: any[]) {
        const reader = body.getReader(...args);
        return new Proxy(reader, { get(target, key) {
          if (key === "read") return async (...readArgs: any[]) => {
            try {
              const result: any = await waitWithAbort(target.read(...readArgs), controller.signal);
              if (result.done) dispose();
              return result;
            } catch (error) { dispose(); throw error; }
          };
          if (key === "cancel" || key === "releaseLock") return (...callArgs: any[]) => {
            dispose(); return target[key](...callArgs);
          };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        } });
      } };
      return new Proxy(response, { get(target, key) {
        if (key === "body") return wrapped;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    },
  };
}

export async function withRequestScope<T>(
  options: { timeoutMs?: number; signal?: AbortSignal },
  action: (scope: RequestScope) => Promise<T>,
): Promise<T> {
  const scope = requestScope(options);
  try {
    if (scope.signal.aborted) throw scope.signal.reason;
    return await scope.wait(action(scope));
  } finally { scope.dispose(); }
}
