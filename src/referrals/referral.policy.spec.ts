import {
  canonicalEmail,
  canonicalEmailHash,
  isSameMailbox,
  maskDisplayName,
  normalizeReferralCode,
  referralRewardReference,
} from './referral.policy';

describe('referral policy', () => {
  it.each([
    [' abcd2345 ', 'ABCD2345'],
    ['ABCDEF', 'ABCDEF'],
    ['A'.repeat(16), 'A'.repeat(16)],
  ])('accepts the code %p as %p', (raw, code) => {
    expect(normalizeReferralCode(raw)).toBe(code);
  });

  it.each(['', 'ABC12', 'A'.repeat(17), 'ABCD-2345', 'ABCD 2345', 'ÄBCDEFG'])(
    'refuses %p as a code',
    (raw) => {
      expect(normalizeReferralCode(raw)).toBeNull();
    },
  );

  it.each([
    ['Alice@Example.com', 'alice@example.com'],
    ['alice+promo@example.com', 'alice@example.com'],
    ['a.lice@example.com', 'a.lice@example.com'],
    ['A.Lice+x@GoogleMail.com', 'alice@gmail.com'],
    ['a.l.i.c.e@gmail.com', 'alice@gmail.com'],
  ])('canonicalizes %p to %p', (email, canonical) => {
    expect(canonicalEmail(email)).toBe(canonical);
  });

  it('recognizes the same mailbox behind different addresses (self-referral)', () => {
    expect(isSameMailbox('alice@gmail.com', 'a.lice+2@googlemail.com')).toBe(
      true,
    );
    expect(isSameMailbox('alice@example.com', 'alice+2@example.com')).toBe(
      true,
    );
    expect(isSameMailbox('alice@example.com', 'bob@example.com')).toBe(false);
    // Dots only matter outside Gmail.
    expect(isSameMailbox('a.lice@example.com', 'alice@example.com')).toBe(
      false,
    );
  });

  it('hashes the canonical email (64 hex characters, same for the same mailbox)', () => {
    const hash = canonicalEmailHash('alice@gmail.com');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalEmailHash('A.LICE+x@gmail.com')).toBe(hash);
    expect(canonicalEmailHash('bob@gmail.com')).not.toBe(hash);
  });

  it('masks invitees and references rewards per referral', () => {
    expect(maskDisplayName('alice_89')).toBe('al***');
    expect(maskDisplayName('a')).toBe('a***');
    expect(referralRewardReference('ref-1')).toBe('referral-reward:ref-1');
  });
});
