import { AccountPanel } from '@/components/AccountPanel';
import { getAccount, updateAccount } from '../api/accountApi';
import { useEffect, useState } from 'react';
import type { Account } from '../types';
export function SettingsPage() {
  const [account, setAccount] = useState<Account | null>(null);
  useEffect(() => { void getAccount().then(setAccount); }, []);
  return <section><h1>Account settings</h1>{account && <AccountPanel account={account} onSave={name => updateAccount({ displayName: name }).then(setAccount)} />}</section>;
}
