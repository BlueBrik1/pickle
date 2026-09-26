import { Router } from 'express';
import { requireUser } from '../middleware/requireUser';
import { readAccount, saveAccount } from '../services/accountService';
export const accountRouter = Router();
accountRouter.get('/', requireUser, async (_request, response) => response.json(await readAccount('demo-account')));
accountRouter.patch('/', requireUser, async (request, response) => response.json(await saveAccount('demo-account', request.body)));
// Account deletion is proposed work; there is no DELETE route here.
