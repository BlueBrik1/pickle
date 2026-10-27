import { submitOrder, type OrderRequest } from '../api/orders';

export interface CheckoutState {
  submitting: boolean;
  orderId?: string;
  error?: string;
}

export function createCheckout(submit = submitOrder) {
  let state: CheckoutState = { submitting: false };
  return {
    get state() {
      return state;
    },
    async placeOrder(request: OrderRequest) {
      // REQ-CHK-1: ignore repeated calls while an order is in flight.
      if (state.submitting) return state;
      state = { submitting: true };
      try {
        const { id } = await submit(request);
        state = { submitting: false, orderId: id };
      } catch (error) {
        state = { submitting: false, error: String(error) };
      }
      return state;
    },
  };
}

export function formatTotal(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
