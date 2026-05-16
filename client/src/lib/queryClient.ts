import { QueryClient, QueryFunction } from "@tanstack/react-query";

// On Vercel, frontend and API share the same origin — use relative URLs.
// On the Perplexity Computer sandbox, the build step rewrites __PORT_5000__ to
// the proxy path. Keeping both code paths means the same bundle works in both
// environments without rebuilding.
export const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

// In-memory auth token. Cleared on full page reload (cookies/localStorage blocked in sandbox).
let authToken: string | null = null;
const tokenListeners = new Set<(t: string | null) => void>();

export function getAuthToken(): string | null {
  return authToken;
}
export function setAuthToken(t: string | null) {
  authToken = t;
  tokenListeners.forEach((l) => l(t));
}
export function subscribeAuthToken(fn: (t: string | null) => void): () => void {
  tokenListeners.add(fn);
  return () => tokenListeners.delete(fn);
}

/** Append `?t=<token>` to a media URL so <img>/<a download> can authenticate. */
export function withToken(url: string): string {
  if (!authToken) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}t=${encodeURIComponent(authToken)}`;
}

/** Photo records returned by the API. Cloudinary fields are present only for new uploads. */
export interface PhotoLike {
  id: number;
  url?: string | null;
  thumbnailUrl?: string | null;
}

/** Full-size image URL. Prefers Cloudinary; falls back to the token-gated raw endpoint. */
export function photoUrl(photo: PhotoLike): string {
  if (photo.url) return photo.url;
  return withToken(`${API_BASE}/api/photos/${photo.id}/raw`);
}

/** Thumbnail-size image URL. Prefers Cloudinary thumbnail; falls back to the token-gated raw endpoint. */
export function photoThumbUrl(photo: PhotoLike): string {
  if (photo.thumbnailUrl) return photo.thumbnailUrl;
  return withToken(`${API_BASE}/api/photos/${photo.id}/raw`);
}

/** Download URL (Cloudinary redirect handles the attachment header server-side). */
export function photoDownloadUrl(photo: PhotoLike): string {
  return withToken(`${API_BASE}/api/photos/${photo.id}/download`);
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    if (res.status === 401) {
      // Token rejected — clear it so the app shows the login screen.
      setAuthToken(null);
    }
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

function authHeader(): Record<string, string> {
  return authToken ? { Authorization: `Bearer ${authToken}` } : {};
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const isFormData = typeof FormData !== "undefined" && data instanceof FormData;
  const headers: Record<string, string> = { ...authHeader() };
  if (!isFormData && data) headers["Content-Type"] = "application/json";
  const res = await fetch(`${API_BASE}${url}`, {
    method,
    headers,
    body: isFormData ? (data as FormData) : data ? JSON.stringify(data) : undefined,
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(`${API_BASE}${queryKey.join("/")}`, {
      headers: { ...authHeader() },
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
