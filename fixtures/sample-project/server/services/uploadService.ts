import { addAttachment } from '../data/attachmentRepository';
import { putStoredObject } from '../storage/storageClient';
export async function storeAttachment(profileId: string, objectKey: string) {
  await putStoredObject(objectKey);
  return addAttachment(profileId, objectKey);
}
