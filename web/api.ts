// サーバーとのやりとり
import { M } from "../src/shared/messages";

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError(M.error.unknown, 0);
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) {
    if (res.status === 401 && path !== "/api/login") window.dispatchEvent(new Event("cq:unauthorized"));
    throw new ApiError(data?.error ?? M.error.unknown, res.status);
  }
  return data as T;
}

export const get = <T>(path: string): Promise<T> => request<T>(path);
export const post = <T>(path: string, body: unknown = {}): Promise<T> => request<T>(path, body);
/** 操作を1つ実行する（人の操作として履歴に残る） */
export const op = <T = unknown>(name: string, args: unknown): Promise<T> => post<T>(`/api/op/${name}`, args);
