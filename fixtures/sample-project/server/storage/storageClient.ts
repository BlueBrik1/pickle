import { storageConfig } from '../config/storage';
const bucketName = process.env.UPLOAD_BUCKET;
// MOCK storage only. No external SDK or live service is used.
export async function listStoredObjects(_profileId: string) { return [{bucket: bucketName ?? storageConfig.bucket, key: 'demo-object'}]; }
export async function putStoredObject(key: string) { return {bucket: storageConfig.bucket, key}; }
