import { mock } from 'jest-mock-extended';
import type { CustomLoggerService } from '../../common/services/custom-logger.service';

const mockStripeInstance = {
  customers: { create: jest.fn() },
  checkout: { sessions: { create: jest.fn(), expire: jest.fn() } },
  webhooks: { constructEvent: jest.fn() },
};

const stripeConstructor = jest
  .fn()
  .mockImplementation(() => mockStripeInstance);

// The SDK is never allowed to make a real network call in a unit test: the
// whole module is replaced, and every test asserts against the mock above.
jest.mock('stripe', () => ({
  __esModule: true,
  default: stripeConstructor,
}));

// Imported after the mock so StripeClientService picks up the mocked module.
import { StripeClientService } from './stripe-client.service';

describe('StripeClientService', () => {
  const logger = mock<CustomLoggerService>();
  let service: StripeClientService;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_123';
    service = new StripeClientService(logger);
  });

  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  describe('configuration', () => {
    it('throws instead of calling Stripe when STRIPE_SECRET_KEY is missing', async () => {
      delete process.env.STRIPE_SECRET_KEY;
      await expect(
        service.createCustomer({ email: 'a@b.com' }),
      ).rejects.toThrow('Stripe is not configured');
      expect(stripeConstructor).not.toHaveBeenCalled();
    });

    it('creates the SDK client only once, on first use', async () => {
      mockStripeInstance.customers.create.mockResolvedValue({ id: 'cus_1' });
      await service.createCustomer({ email: 'a@b.com' });
      await service.createCustomer({ email: 'a@b.com' });
      expect(stripeConstructor).toHaveBeenCalledTimes(1);
    });
  });

  describe('createCustomer', () => {
    it('delegates to Stripe and returns the created customer', async () => {
      mockStripeInstance.customers.create.mockResolvedValue({ id: 'cus_1' });
      const result = await service.createCustomer(
        { email: 'a@b.com' },
        { idempotencyKey: 'key-1' },
      );
      expect(result).toEqual({ id: 'cus_1' });
      expect(mockStripeInstance.customers.create).toHaveBeenCalledWith(
        { email: 'a@b.com' },
        { idempotencyKey: 'key-1' },
      );
    });
  });

  describe('createCheckoutSession', () => {
    it('delegates to Stripe and returns the created session', async () => {
      mockStripeInstance.checkout.sessions.create.mockResolvedValue({
        id: 'cs_1',
      });
      const params = { mode: 'subscription' as const };
      const result = await service.createCheckoutSession(params);
      expect(result).toEqual({ id: 'cs_1' });
      expect(mockStripeInstance.checkout.sessions.create).toHaveBeenCalledWith(
        params,
        undefined,
      );
    });
  });

  describe('expireCheckoutSession', () => {
    it('expires the session on Stripe', async () => {
      mockStripeInstance.checkout.sessions.expire.mockResolvedValue({});
      await service.expireCheckoutSession('cs_1');
      expect(mockStripeInstance.checkout.sessions.expire).toHaveBeenCalledWith(
        'cs_1',
      );
    });

    it('swallows an error instead of throwing (best-effort)', async () => {
      mockStripeInstance.checkout.sessions.expire.mockRejectedValue(
        new Error('already expired'),
      );
      await expect(
        service.expireCheckoutSession('cs_1'),
      ).resolves.toBeUndefined();
      expect(logger.warn.mock.calls).toEqual([
        [expect.stringContaining('cs_1'), 'StripeClientService'],
      ]);
    });
  });

  describe('constructWebhookEvent', () => {
    it('rejects a request with no signature header without calling Stripe', () => {
      expect(() =>
        service.constructWebhookEvent(Buffer.from('{}'), undefined),
      ).toThrow('Missing Stripe-Signature header');
      expect(mockStripeInstance.webhooks.constructEvent).not.toHaveBeenCalled();
    });

    it('returns the verified event on a valid signature', () => {
      const event = { id: 'evt_1', type: 'checkout.session.completed' };
      mockStripeInstance.webhooks.constructEvent.mockReturnValue(event);

      const result = service.constructWebhookEvent(Buffer.from('{}'), 'sig_1');

      expect(result).toBe(event);
      expect(mockStripeInstance.webhooks.constructEvent).toHaveBeenCalledWith(
        Buffer.from('{}'),
        'sig_1',
        'whsec_123',
      );
    });

    it('wraps a signature verification failure as a 400 AppError', () => {
      mockStripeInstance.webhooks.constructEvent.mockImplementation(() => {
        throw new Error('signature mismatch');
      });

      expect(() =>
        service.constructWebhookEvent(Buffer.from('{}'), 'bad-sig'),
      ).toThrow('Invalid Stripe webhook signature');
    });
  });
});
