import { useState } from 'react';
import { CheckoutButton } from './CheckoutButton';
import { OrderSummary } from './OrderSummary';
import { createCheckout } from './useCheckout';

const checkout = createCheckout();

export function CheckoutPage({ cartId, totalCents }: { cartId: string; totalCents: number }) {
  const [state, setState] = useState(checkout.state);
  const onSubmit = async () => {
    setState({ submitting: true });
    setState(await checkout.placeOrder({ cartId, totalCents }));
  };
  return (
    <section className="page">
      <OrderSummary totalCents={totalCents} />
      {state.error && <p className="error">{state.error}</p>}
      <CheckoutButton submitting={state.submitting} onSubmit={onSubmit} />
    </section>
  );
}
