interface CheckoutButtonProps {
  submitting: boolean;
  onSubmit: () => void;
}

export function CheckoutButton({ submitting, onSubmit }: CheckoutButtonProps) {
  return (
    <button
      type="submit"
      className="bg-[#2563eb] text-[#ffffff] px-4 py-2 rounded"
      disabled={submitting}
      aria-busy={submitting}
      onClick={onSubmit}
    >
      {submitting ? 'Placing order…' : 'Place order'}
    </button>
  );
}
