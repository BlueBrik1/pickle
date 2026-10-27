import { PrimaryButton } from '../components/PrimaryButton';
import { Header } from '../components/Header';

export function CartPage({ onCheckout }: { onCheckout: () => void }) {
  return (
    <main className="page">
      <Header title="Your cart" />
      <PrimaryButton label="Continue to checkout" onClick={onCheckout} />
    </main>
  );
}
