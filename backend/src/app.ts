import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { config } from './config';
import { requestId } from './middleware/requestId';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { authenticate } from './middleware/auth';
import { healthRouter } from './routes/health';
import { authRouter } from './routes/auth';
import { adminRouter } from './routes/admin';
import { usersRouter } from './routes/users';
import { docsRouter } from './routes/docs';
import { kioskRouter } from './routes/kiosk';
import { structureRouter } from './routes/structure';
import { employeesRouter } from './routes/employees';
import { timeOffsRouter } from './routes/timeOffs';
import { schedulesRouter } from './routes/schedules';
import { attendanceRouter } from './routes/attendance';
import { wishesRouter } from './routes/wishes';
import { portalRouter } from './routes/portal';
import { inquiriesRouter } from './routes/inquiries';
import { analyticsRouter } from './routes/analytics';

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', /^\d+$/.test(config.TRUST_PROXY) ? Number(config.TRUST_PROXY) : config.TRUST_PROXY);
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)),
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use(requestId);

  const api = express.Router();
  api.use(healthRouter);
  api.use(docsRouter);
  api.use('/auth', authRouter);
  api.use('/kiosk', kioskRouter);
  // everything below requires a user session
  api.use(authenticate);
  api.use(adminRouter);
  api.use('/users', usersRouter);
  api.use(structureRouter);
  api.use(employeesRouter);
  api.use(timeOffsRouter);
  api.use(schedulesRouter);
  api.use(attendanceRouter);
  api.use(wishesRouter);
  api.use(portalRouter);
  api.use(inquiriesRouter);
  api.use(analyticsRouter);

  app.use('/api/v1', api);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
