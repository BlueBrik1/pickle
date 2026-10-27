import { describe, expect, it, vi } from 'vitest';
import { createCheckout, formatTotal } from '../src/checkout/useCheckout';

describe('createCheckout', () => {
  it('submits an order once even when placeOrder is called twice (REQ-CHK-1)', async () => {
    let resolve!: (v: { id: string }) => void;
    const submit = vi.fn(() => new Promise<{ id: string }>((r) => (resolve = r)));
    const checkout = createCheckout(submit);
    const first = checkout.placeOrder({ cartId: 'c1', totalCents: 100 });
    await checkout.placeOrder({ cartId: 'c1', totalCents: 100 });
    resolve({ id: 'o1' });
    expect((await first).orderId).toBe('o1');
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('formats totals', () => {
    expect(formatTotal(4200)).toBe('$42.00');
  });
});
