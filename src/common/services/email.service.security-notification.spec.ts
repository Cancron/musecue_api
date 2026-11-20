import { EmailService } from './email.service';
import { SECURITY_NOTIFICATIONS } from '../queues/email/security-notifications';

/** The security-notification email as rendered from its template. */
describe('EmailService security notifications', () => {
  const sent: Array<{ to: string; subject: string; html: string }> = [];
  const service = Object.create(EmailService.prototype) as EmailService;
  service.sendEmail = (options: {
    to: string;
    subject: string;
    html?: string;
  }) => {
    sent.push({
      to: options.to,
      subject: options.subject,
      html: options.html ?? '',
    });
    return Promise.resolve();
  };

  beforeEach(() => {
    sent.length = 0;
  });

  it.each(Object.keys(SECURITY_NOTIFICATIONS))(
    'renders %s: what changed and when, nothing else',
    async (event) => {
      await service.sendSecurityNotificationEmail(
        'ann@example.com',
        'ann',
        event as keyof typeof SECURITY_NOTIFICATIONS,
        '2026-11-26T09:00:00.000Z',
      );

      const [email] = sent;
      const text =
        SECURITY_NOTIFICATIONS[event as keyof typeof SECURITY_NOTIFICATIONS];
      expect(email.to).toBe('ann@example.com');
      expect(email.subject).toBe(text.subject);
      expect(email.html).toContain(text.title);
      expect(email.html).toContain('Thu, 26 Nov 2026 09:00:00 GMT');
      expect(email.html).not.toMatch(/\{\{\w+\}\}/); // every placeholder filled
    },
  );

  it('escapes the username', async () => {
    await service.sendSecurityNotificationEmail(
      'x@example.com',
      '<script>alert(1)</script>',
      'MFA_DISABLED',
      '2026-11-26T09:00:00.000Z',
    );
    expect(sent[0].html).not.toContain('<script>');
    expect(sent[0].html).toContain('&lt;script&gt;');
  });
});
