import { Inject, Injectable, Optional } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import * as fs from 'fs';
import * as path from 'path';
import config from '../config/app.config';
import AppError from '../errors/app.error';
import httpStatus from 'http-status';
import { EMAIL_SUBJECTS } from '../queues/email/email-delivery';
import { CustomLoggerService } from './custom-logger.service';

/** The SMTP transport (nodemailer in production; a mock in tests). */
export interface EmailTransport {
  sendMail(options: nodemailer.SendMailOptions): Promise<unknown>;
}

export const EMAIL_TRANSPORT = Symbol('EMAIL_TRANSPORT');

/** The configured SMTP server. */
export function createSmtpTransport(): EmailTransport {
  return nodemailer.createTransport({
    host: String(config.email_host),
    port: Number(config.email_port),
    secure: config.email_port === 465, // true for 465, false for other ports
    auth: {
      user: String(config.email_user),
      pass: String(config.email_pass),
    },
  });
}

/**
 * An SMTP delivery failed. Carries the SMTP response code or the transport
 * error code, recorded in the email's delivery history.
 */
export class EmailDeliveryError extends Error {
  constructor(
    message: string,
    readonly responseCode?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'EmailDeliveryError';
  }
}

export interface EmailOptions {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

@Injectable()
export class EmailService {
  private readonly transporter: EmailTransport;

  constructor(
    private readonly customLogger: CustomLoggerService,
    @Optional() @Inject(EMAIL_TRANSPORT) transport?: EmailTransport,
  ) {
    this.transporter = transport ?? createSmtpTransport();
  }

  /**
   * Send an email
   */
  async sendEmail(options: EmailOptions): Promise<void> {
    this.customLogger.log(
      `Sending email to: ${options.to}, subject: ${options.subject}`,
      'EmailService',
    );
    const mailOptions = {
      from: String(config.email_from || config.email_user),
      to: options.to,
      subject: options.subject,
      text: options.text,
      html: options.html,
    };

    try {
      await this.transporter.sendMail(mailOptions);
      this.customLogger.log(
        `Email sent successfully to: ${options.to}`,
        'EmailService',
      );
    } catch (error) {
      this.customLogger.error(
        `Error sending email to ${options.to}`,
        error instanceof Error ? error.stack : undefined,
        'EmailService',
      );
      const smtp = error as { responseCode?: number; code?: string };
      throw new EmailDeliveryError(
        (error instanceof Error ? error.message : 'Email sending failed').slice(
          0,
          300,
        ),
        typeof smtp?.responseCode === 'number' ? smtp.responseCode : undefined,
        typeof smtp?.code === 'string' ? smtp.code : undefined,
      );
    }
  }

  /**
   * Load and parse email template
   */
  getEmailTemplate(
    filePath: string,
    replacements: Record<string, string>,
  ): string {
    try {
      const absolutePath = path.resolve(
        process.cwd(),
        'templates',
        'emails',
        filePath,
      );
      let template = fs.readFileSync(absolutePath, { encoding: 'utf-8' });

      for (const key in replacements) {
        template = template.replace(
          new RegExp(`{{${key}}}`, 'g'),
          replacements[key],
        );
      }

      return template;
    } catch (error) {
      console.error('Error reading email template:', error);
      throw new AppError(
        httpStatus.INTERNAL_SERVER_ERROR,
        'Email template loading failed.',
      );
    }
  }

  /**
   * Send verification email
   */
  async sendVerificationEmail(
    email: string,
    username: string,
    verificationCode: string,
  ): Promise<void> {
    const html = this.getEmailTemplate('verification.html', {
      username,
      verificationCode,
      year: new Date().getFullYear().toString(),
    });

    await this.sendEmail({
      to: email,
      subject: EMAIL_SUBJECTS.verification,
      html,
    });
  }

  /**
   * Send the one-time code that confirms a permanent account deletion
   */
  async sendAccountDeletionCodeEmail(
    email: string,
    username: string,
    code: string,
    expiresInMinutes: number,
  ): Promise<void> {
    const html = this.getEmailTemplate('account-deletion-code.html', {
      username,
      code,
      expiresInMinutes: String(expiresInMinutes),
      year: new Date().getFullYear().toString(),
    });

    await this.sendEmail({
      to: email,
      subject: EMAIL_SUBJECTS.accountDeletion,
      html,
    });
  }

  /**
   * Send password reset email
   */
  async sendPasswordResetEmail(
    email: string,
    username: string,
    resetCode: string,
  ): Promise<void> {
    const html = this.getEmailTemplate('password-reset.html', {
      username,
      resetCode,
      year: new Date().getFullYear().toString(),
    });

    await this.sendEmail({
      to: email,
      subject: 'Reset your MuseCue password',
      html,
    });
  }

  /**
   * Send the email of an inbox notification (title and message are written
   * by the application; HTML-escaped here)
   */
  async sendNotificationEmail(
    email: string,
    username: string,
    title: string,
    message: string,
  ): Promise<void> {
    const html = this.getEmailTemplate('notification.html', {
      username: escapeHtml(username),
      title: escapeHtml(title),
      message: escapeHtml(message),
      year: new Date().getFullYear().toString(),
    });

    await this.sendEmail({ to: email, subject: title, html });
  }

  /**
   * Send welcome email after verification
   */
  async sendWelcomeEmail(email: string, username: string): Promise<void> {
    const html = this.getEmailTemplate('welcome.html', {
      username,
      year: new Date().getFullYear().toString(),
    });

    await this.sendEmail({
      to: email,
      subject: EMAIL_SUBJECTS.welcome,
      html,
    });
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
