import express from 'express';
import { accountRouter } from './routes/accountRoutes';
import { uploadRouter } from './routes/uploadRoutes';
export const app = express();
app.use(express.json());
app.use('/api/account', accountRouter);
app.use('/api/upload', uploadRouter);
// A synthetic source fixture: Pickle never starts this server.
