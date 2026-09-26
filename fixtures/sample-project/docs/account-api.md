# Existing account API

`GET /api/account` reads the fictional account. `PATCH /api/account` updates its display name.
The handlers live in `server/routes/accountRoutes.ts` and use `server/services/accountService.ts`.
The browser client is `src/api/accountApi.ts`. No account-deletion route exists yet.
