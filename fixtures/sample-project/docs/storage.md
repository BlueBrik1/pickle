# Mock attachment storage

`UPLOAD_BUCKET` is the bucket-name setting read by `server/config/storage.ts` and `server/storage/storageClient.ts`.
`POST /api/upload` creates fictional metadata only. This fixture never connects to a storage service.
