# Account data review

This is a synthetic demonstration. `schema/profiles.sql` defines account status.
`schema/posts.sql`, `schema/oauth_tokens.sql`, and `schema/attachments.sql` record linked data.
Deletion is proposed work: decide retention and token revocation behavior before implementation.
Stored object cleanup requires separate review in `server/storage/storageClient.ts`.
