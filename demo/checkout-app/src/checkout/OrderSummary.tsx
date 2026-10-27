import { formatTotal } from './useCheckout';

export function OrderSummary({ totalCents }: { totalCents: number }) {
  return <p className="text-[#111827] text-[16px]">Total: {formatTotal(totalCents)}</p>;
}
