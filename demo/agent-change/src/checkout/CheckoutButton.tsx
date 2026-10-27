interface CheckoutButtonProps {
  submitting: boolean;
  onSubmit: () => void;
  size?: 'regular' | 'large';
}

export function CheckoutButton({ submitting, onSubmit, size = 'regular' }: CheckoutButtonProps) {
  return (
    <button
      type="submit"
      className={`bg-[#2a6bf0] text-[#ffffff] rounded ${size === 'large' ? 'px-6 py-4' : 'px-4 py-2'}`}
      aria-busy={submitting}
      onClick={onSubmit}
    >
      {submitting ? 'Placing order…' : 'Place order'}
    </button>
  );
}
