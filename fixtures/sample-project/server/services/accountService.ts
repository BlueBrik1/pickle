import { findProfile, updateProfile } from '../data/accountRepository';
import { listPosts } from '../data/postRepository';
import { listTokens } from '../data/tokenRepository';
import { listAttachments } from '../data/attachmentRepository';
import { listStoredObjects } from '../storage/storageClient';
import type { Account } from '../../src/types/account';
export async function readAccount(id: string) {
  const profile = await findProfile(id);
  const linked = await Promise.all([listPosts(id), listTokens(id), listAttachments(id), listStoredObjects(id)]);
  return { ...profile, linkedCounts: linked.map(items => items.length) };
}
export async function saveAccount(id: string, update: Pick<Account, 'displayName'>) { return updateProfile(id, update); }
