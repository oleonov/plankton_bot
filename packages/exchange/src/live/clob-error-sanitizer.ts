/**
 * Strips circular references from axios error config before the CLOB SDK
 * tries to JSON.stringify it.
 *
 * @polymarket/clob-client@4.22.8 logs request errors via:
 *   console.error("[CLOB Client] request error", JSON.stringify({
 *     status, statusText, data, config: err.response.config,
 *   }))
 *
 * `config.httpsAgent` references the keep-alive socket pool, which holds
 * back-references to live sockets and ClientRequest objects → JSON.stringify
 * throws TypeError "Converting circular structure to JSON" before
 * console.error fires. The TypeError propagates out of the SDK in place of
 * the real HTTP error, masking root causes like "not enough balance" with
 * a generic UNKNOWN classification.
 *
 * The interceptor mutates the live error object (axios reuses references),
 * dropping the agent fields. Functions on `transform*`/`adapter` are also
 * cleared because the SDK serializer keeps array slots for them as nulls
 * but third-party axios plugins occasionally store circular state there.
 */
interface AxiosLikeInstance {
  interceptors: {
    response: {
      use(
        onFulfilled?: ((value: unknown) => unknown) | null,
        onRejected?: (error: unknown) => unknown,
      ): number;
    };
  };
}

const installed = new WeakSet<object>();

export function installClobErrorSanitizer(axiosInstance: AxiosLikeInstance): void {
  if (installed.has(axiosInstance)) return;
  installed.add(axiosInstance);

  axiosInstance.interceptors.response.use(undefined, (error: unknown) => {
    sanitizeAxiosError(error);
    // Forwarding axios's original rejection reason is required so downstream
    // SDK code keeps the AxiosError contract; wrapping it in a fresh Error
    // would break err.response/err.config handling in @polymarket/clob-client.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    return Promise.reject(error);
  });
}

export function sanitizeAxiosError(error: unknown): void {
  if (!error || typeof error !== "object") return;
  const err = error as {
    config?: unknown;
    response?: { config?: unknown } | undefined;
  };
  cleanConfig(err.config);
  cleanConfig(err.response?.config);
}

function cleanConfig(config: unknown): void {
  if (!config || typeof config !== "object") return;
  const target = config as Record<string, unknown>;
  delete target["httpsAgent"];
  delete target["httpAgent"];
  delete target["transformRequest"];
  delete target["transformResponse"];
  delete target["adapter"];
}
