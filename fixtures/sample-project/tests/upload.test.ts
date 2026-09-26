import { describe, it, expect } from 'vitest';
import { putStoredObject } from '../server/storage/storageClient';
describe('mock storage metadata', () => {
  it('keeps the object key', async () => { expect((await putStoredObject('demo-object')).key).toBe('demo-object'); });
});
