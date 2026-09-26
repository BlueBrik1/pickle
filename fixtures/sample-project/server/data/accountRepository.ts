import { db } from './mockClient';
import type { Account } from '../../src/types/account';
export async function findProfile(_id: string) { return db.from('profiles').select()[0]; }
export async function updateProfile(_id: string, update: Pick<Account, 'displayName'>) { return db.from('profiles').update(update); }
