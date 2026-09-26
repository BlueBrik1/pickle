import type { Account } from '../types/account';
import { StatusBadge } from './StatusBadge';
export function AccountPanel({ account, onSave }: { account: Account; onSave: (name: string) => void }) {
  return <div><h2>{account.displayName}</h2><StatusBadge status={account.status} /><button onClick={() => onSave('Demo person')}>Save profile</button></div>;
}
