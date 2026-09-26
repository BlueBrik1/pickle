import { LIMITS } from '../shared/schema';

export async function api<T>(
  path: string,
  body?: unknown,
  method?: string,
  signal?: AbortSignal,
): Promise<T> {
  const encodedBody = body === undefined ? undefined : JSON.stringify(body);
  if (encodedBody && new TextEncoder().encode(encodedBody).length > LIMITS.bodyBytes)
    throw new Error('The encoded upload exceeds 16 MiB. Choose a smaller project.');
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: encodedBody,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error('The Pickle service is unavailable. Check that it is running, then try again.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      response.status === 410
        ? 'This session or snapshot expired. Reload your project to continue.'
        : response.status === 404 && /^\/(repositories|analyses)\//.test(path)
          ? 'This project or analysis is unavailable or has expired. Reload your project to continue.'
          : (data.message ??
            data.error?.message ??
            (typeof data.error === 'string' ? data.error : null) ??
            'The request could not be completed. Try again.'),
    );
  return data as T;
}
