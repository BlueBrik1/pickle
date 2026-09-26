export type AccountStatus = 'active' | 'paused';
export interface Account { id: string; displayName: string; status: AccountStatus }
