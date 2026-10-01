// Typed client for the app's REST endpoints (src/routes/api/**).
// Unwraps the resp.ts envelope: { code: 0 | -1, message, data? }.

export class ApiError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface PageResult<T> {
  items: T[];
  total: number;
}

export interface PageParams {
  page: number;
  pageSize: number;
  search?: string;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  const json = await res
    .json()
    .catch(() => ({ code: -1, message: res.statusText || 'Request failed' }));
  if (json.code !== 0) {
    throw new ApiError(
      json.code ?? -1,
      json.message || 'Request failed',
      json.data
    );
  }
  // respOk() omits data entirely — callers expecting void get undefined.
  return json.data as T;
}

export const apiGet = <T>(url: string, init?: RequestInit) =>
  request<T>(url, init);

export const apiPost = <T = void>(url: string, body?: unknown) =>
  request<T>(url, {
    method: 'POST',
    body: body == null ? undefined : JSON.stringify(body),
  });

export const apiPut = <T = void>(url: string, body?: unknown) =>
  request<T>(url, { method: 'PUT', body: JSON.stringify(body) });

export const apiPatch = <T = void>(url: string, body?: unknown) =>
  request<T>(url, { method: 'PATCH', body: JSON.stringify(body) });

export const apiDelete = <T = void>(url: string) =>
  request<T>(url, { method: 'DELETE' });

export interface DownloadResult {
  blob: Blob;
  /** From Content-Disposition, so the server's name (e.g. the book title) wins. */
  filename?: string;
}

/**
 * Pull a binary response (the printable PDF export).
 *
 * Separate from request() because that one always parses JSON. Endpoints that
 * serve files answer with a real HTTP error status plus a JSON body instead of
 * the usual 200 + `code: -1` envelope, so both shapes are handled here.
 */
export async function apiDownload(url: string): Promise<DownloadResult> {
  const res = await fetch(url);
  if (!res.ok) {
    const json = await res
      .json()
      .catch(() => ({ message: res.statusText || 'Download failed' }));
    throw new ApiError(
      res.status,
      json.message || 'Download failed',
      json.data
    );
  }

  // RFC 5987: filename* carries the UTF-8 name, filename is the ASCII fallback.
  const disposition = res.headers.get('content-disposition') ?? '';
  const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = disposition.match(/filename="([^"]+)"/i)?.[1];
  let filename: string | undefined;
  if (utf8) {
    try {
      filename = decodeURIComponent(utf8);
    } catch {
      filename = plain;
    }
  } else {
    filename = plain;
  }

  return { blob: await res.blob(), filename };
}

// Query-string builder for paginated list endpoints.
export function pageQuery(base: string, p: PageParams) {
  const params = new URLSearchParams({
    page: String(p.page),
    pageSize: String(p.pageSize),
  });
  if (p.search) params.set('search', p.search);
  return `${base}?${params}`;
}
