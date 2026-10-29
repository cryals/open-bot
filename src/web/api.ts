export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
let csrf = '';
export const setCsrf = (value: string) => {
  csrf = value;
};
export async function uploadMedia(file: File, kind: 'image' | 'file') {
  const body = new FormData();
  body.append('file', file);
  const response = await fetch('/api/media?kind=' + kind, {
    method: 'POST',
    body,
    headers: { 'X-CSRF-Token': csrf },
    credentials: 'same-origin',
  });
  const data = (await response.json()) as { url: string; name: string; error?: string };
  if (!response.ok) throw new ApiError(response.status, data.error || 'Не удалось загрузить файл');
  return data;
}
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new ApiError(response.status, data.error || 'Не удалось выполнить запрос');
  return data;
}
