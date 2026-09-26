import { db } from './mockClient';
// Returns synthetic metadata only; no working OAuth credentials exist.
export async function listTokens(_profileId: string) { return db.from('oauth_tokens').select(); }
