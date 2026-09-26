import type { AccountStatus } from '@/types/account';
export function StatusBadge({status}: {status: AccountStatus}) { return <span>Account status: {status}</span>; }
