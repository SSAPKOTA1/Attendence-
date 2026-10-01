import nodemailer from 'nodemailer';
import { config } from '../config';
import { logger } from '../logger';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  /** true when links (invite/reset) may be returned in API responses instead of being mailed (dev/test) */
  readonly exposesLinks: boolean;
  send(msg: MailMessage): Promise<void>;
}

class ConsoleMailer implements Mailer {
  readonly exposesLinks = true;
  async send(msg: MailMessage): Promise<void> {
    logger.info({ mail: { to: msg.to, subject: msg.subject } }, 'mail (console mode)');
    if (config.NODE_ENV === 'development') console.log(`[mail] to=${msg.to} subject=${msg.subject}\n${msg.text}`);
  }
}

export class MemoryMailer implements Mailer {
  readonly exposesLinks = true;
  readonly outbox: MailMessage[] = [];
  failNext = 0;
  async send(msg: MailMessage): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('simulated mail failure');
    }
    this.outbox.push(msg);
  }
}

class DisabledMailer implements Mailer {
  readonly exposesLinks = true;
  async send(): Promise<void> {
    /* no-op */
  }
}

class SmtpMailer implements Mailer {
  readonly exposesLinks = false;
  private transport = nodemailer.createTransport(config.SMTP_URL ?? '');
  async send(msg: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: config.MAIL_FROM, to: msg.to, subject: msg.subject, text: msg.text });
  }
}

function create(): Mailer {
  switch (config.MAIL_MODE) {
    case 'smtp':
      return new SmtpMailer();
    case 'memory':
      return new MemoryMailer();
    case 'disabled':
      return new DisabledMailer();
    default:
      return new ConsoleMailer();
  }
}

export const mailer: Mailer = create();

export function link(path: string, token: string): string {
  return `${config.APP_URL.replace(/\/$/, '')}/${path}?token=${encodeURIComponent(token)}`;
}
