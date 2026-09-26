import { db } from './mockClient';
export async function listPosts(_profileId: string) { return db.from('posts').select(); }
