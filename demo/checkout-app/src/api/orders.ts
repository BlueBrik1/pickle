import { sessionToken } from '../auth/session';

export interface OrderRequest {
  cartId: string;
  totalCents: number;
}

export async function submitOrder(request: OrderRequest): Promise<{ id: string }> {
  const response = await fetch('/api/orders', {
    method: 'POST',
    headers: { authorization: `Bearer ${sessionToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error(`Order failed (${response.status})`);
  return response.json();
}
