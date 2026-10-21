import { createTransport, type Transporter } from 'nodemailer';
import type { Mailer } from '../ports.js';
import type { Email } from './templates.js';

/** SMTP delivery: Mailpit in development, the provider of the platform in production. */
export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(
    url: string,
    private readonly from: string,
  ) {
    this.transport = createTransport(url);
  }

  async send(to: string, email: Email): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to,
      subject: email.subject,
      text: email.text,
    });
  }

  close(): void {
    this.transport.close();
  }
}
