import type { AuthContext, DeviceContext } from './context';
import type { Lang } from '../errors/catalog';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      lang: Lang;
      ctx?: AuthContext;
      device?: DeviceContext;
    }
  }
}

export {};
