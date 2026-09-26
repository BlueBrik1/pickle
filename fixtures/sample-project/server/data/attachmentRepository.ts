import { db } from './mockClient';
export async function listAttachments(_profileId: string) { return db.from('attachments').select(); }
export async function addAttachment(profileId: string, objectKey: string) { return db.from('attachments').insert({profileId, objectKey}); }
