import { describe, it, expect } from 'vitest';
import { readAccount } from '../server/services/accountService';
describe('existing account read path', () => {
  it('returns a fictional profile', async () => { expect((await readAccount('demo-account')).displayName).toBe('Demo person'); });
});
// This does not test account deletion, retention, authorization, or cleanup.
