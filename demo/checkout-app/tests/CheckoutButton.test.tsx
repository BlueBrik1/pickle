import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CheckoutButton } from '../src/checkout/CheckoutButton';

describe('CheckoutButton', () => {
  it('is disabled while an order is submitting (REQ-CHK-1)', () => {
    const html = renderToStaticMarkup(<CheckoutButton submitting onSubmit={() => {}} />);
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(html).toContain('Placing order…');
  });

  it('is enabled when idle', () => {
    const html = renderToStaticMarkup(<CheckoutButton submitting={false} onSubmit={() => {}} />);
    expect(html).not.toMatch(/<button[^>]*disabled/);
  });
});
