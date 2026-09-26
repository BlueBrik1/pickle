import type { Account } from '../types/account';
export async function getAccount(): Promise<Account> {
  const response = await fetch('/api/account', { method: 'GET' });
  return response.json();
}
export async function updateAccount(update: Pick<Account, 'displayName'>): Promise<Account> {
  const response = await fetch('/api/account', { method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(update) });
  return response.json();
}
