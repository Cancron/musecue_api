import { Injectable } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import * as fs from 'fs';
import * as path from 'path';
import config from '../config/app.config';
import AppError from '../errors/app.error';
import httpStatus from 'http-status';
import { CustomLoggerService } from './custom-logger.service';
import {
  SECURITY_NOTIFICATIONS,
  type SecurityNotificationEvent,
} from '../queues/email/security-notifications';

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export interface EmailOptions {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

@Injectable()
export class EmailService {
  private transporter: nodemailer.Transporter;

  constructor(private readonly customLogger: CustomLoggerService) {
    this.transporter = nodemailer.createTransport({
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
      console.error('Error sending email:', error);
      throw AppError.badRequest('Email sending failed, something went wrong!');
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
      subject: 'Verify your MuseCue email address',
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
      subject: 'Confirm the deletion of your MuseCue account',
      html,
    });
  }

  /**
   * Send a security notification: fixed text per event (what changed and
   * when), never a secret, code or token. Values are HTML-escaped.
   */
  async sendSecurityNotificationEmail(
    email: string,
    username: string,
    event: SecurityNotificationEvent,
    occurredAt: string,
  ): Promise<void> {
    const text = SECURITY_NOTIFICATIONS[event];
    const html = this.getEmailTemplate('security-notification.html', {
      username: escapeHtml(username),
      title: escapeHtml(text.title),
      description: escapeHtml(text.description),
      occurredAt: escapeHtml(new Date(occurredAt).toUTCString()),
      year: new Date().getFullYear().toString(),
    });

    await this.sendEmail({ to: email, subject: text.subject, html });
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
   * Send welcome email after verification
   */
  async sendWelcomeEmail(email: string, username: string): Promise<void> {
    const html = this.getEmailTemplate('welcome.html', {
      username,
      year: new Date().getFullYear().toString(),
    });

    await this.sendEmail({
      to: email,
      subject: 'Welcome to MuseCue!',
      html,
    });
  }
}
