export async function uploadAttachment(file: File) {
  const body = new FormData(); body.append('attachment', file);
  const response = await fetch('/api/upload', { method: 'POST', body });
  return response.json();
}
