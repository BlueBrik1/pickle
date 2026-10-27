import { Header } from '../components/Header';
import { formatTotal } from '../checkout/useCheckout';

export function ReceiptPage({ totalCents }: { totalCents: number }) {
  return (
    <main className="page">
      <Header title="Thanks for your order" />
      <p>Charged {formatTotal(totalCents)}</p>
    </main>
  );
}
