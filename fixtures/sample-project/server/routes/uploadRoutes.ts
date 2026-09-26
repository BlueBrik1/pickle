import { Router } from 'express';
import { requireUser } from '../middleware/requireUser';
import { storeAttachment } from '../services/uploadService';
export const uploadRouter = Router();
uploadRouter.post('/', requireUser, async (_request, response) => response.json(await storeAttachment('demo-account', 'demo-object')));
