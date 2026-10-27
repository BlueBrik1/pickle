export function PrimaryButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button className="bg-[#2563eb] text-[#ffffff] px-4 py-2 rounded" onClick={onClick}>
      {label}
    </button>
  );
}
