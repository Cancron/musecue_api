import { LoyaltyMissionRecurrence } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { mockDeep } from 'jest-mock-extended';
import { recordVerifiedCompletion } from './loyalty-mission-progress.service';
import {
  countingWindow,
  missionPeriod,
  missionRewardReference,
} from './loyalty-mission.policy';

const at = (iso: string) => new Date(iso);
const STARTS = at('2031-01-01T00:00:00.000Z');

describe('daily reward loyalty mission policy', () => {
  it('gives ONCE missions a single period from the mission start', () => {
    expect(
      missionPeriod(
        LoyaltyMissionRecurrence.ONCE,
        at('2031-05-05T10:00:00.000Z'),
        STARTS,
      ),
    ).toEqual({ key: 'once', start: STARTS, end: null });
  });

  it.each([
    // Monday 00:00 UTC starts the week; Sunday 23:59 still belongs to it.
    ['2031-03-03T00:00:00.000Z', '2031-03-03', '2031-03-10'],
    ['2031-03-09T23:59:59.999Z', '2031-03-03', '2031-03-10'],
    ['2031-03-10T00:00:00.000Z', '2031-03-10', '2031-03-17'],
    // Across a month and a year.
    ['2031-04-01T08:00:00.000Z', '2031-03-31', '2031-04-07'],
    ['2032-01-01T12:00:00.000Z', '2031-12-29', '2032-01-05'],
    // A time zone offset never moves it: only UTC counts.
    ['2031-03-10T00:30:00.000+02:00', '2031-03-03', '2031-03-10'],
  ])('puts %s in the UTC week starting %s', (time, start, end) => {
    expect(
      missionPeriod(LoyaltyMissionRecurrence.WEEKLY, at(time), STARTS),
    ).toEqual({
      key: start,
      start: at(`${start}T00:00:00.000Z`),
      end: at(`${end}T00:00:00.000Z`),
    });
  });

  it.each([
    ['2031-02-28T23:59:59.999Z', '2031-02-01', '2031-03-01'],
    ['2032-02-29T12:00:00.000Z', '2032-02-01', '2032-03-01'],
    ['2031-12-31T23:00:00.000Z', '2031-12-01', '2032-01-01'],
  ])('puts %s in the UTC month starting %s', (time, start, end) => {
    expect(
      missionPeriod(LoyaltyMissionRecurrence.MONTHLY, at(time), STARTS),
    ).toEqual({
      key: start,
      start: at(`${start}T00:00:00.000Z`),
      end: at(`${end}T00:00:00.000Z`),
    });
  });

  it('counts completions from the later of the period start and the mission start', () => {
    const startedMidWeek = at('2031-03-05T12:00:00.000Z');
    const week = missionPeriod(
      LoyaltyMissionRecurrence.WEEKLY,
      at('2031-03-06T00:00:00.000Z'),
      startedMidWeek,
    );
    expect(countingWindow(week, startedMidWeek)).toEqual({
      from: startedMidWeek,
      to: at('2031-03-10T00:00:00.000Z'),
    });
    const nextWeek = missionPeriod(
      LoyaltyMissionRecurrence.WEEKLY,
      at('2031-03-11T00:00:00.000Z'),
      startedMidWeek,
    );
    expect(countingWindow(nextWeek, startedMidWeek).from).toEqual(
      at('2031-03-10T00:00:00.000Z'),
    );
  });

  it('references mission credits by award', () => {
    expect(missionRewardReference('a1')).toBe('loyalty-mission:a1');
  });

  describe('recordVerifiedCompletion', () => {
    const completion = {
      sessionId: 'session-1',
      authId: 'user-1',
      completedAt: at('2031-03-03T10:00:00.000Z'),
    };
    const txWith = (steps: number, unfinished: number) => {
      const tx = mockDeep<Prisma.TransactionClient>();
      tx.guideStep.count
        .mockResolvedValueOnce(steps)
        .mockResolvedValueOnce(unfinished);
      tx.makeupCompletion.createMany.mockResolvedValue({ count: 1 });
      return tx;
    };

    it('records a session whose every step was completed', async () => {
      const tx = txWith(4, 0);
      await expect(recordVerifiedCompletion(tx, completion)).resolves.toBe(
        true,
      );
      expect(tx.makeupCompletion.createMany.mock.calls).toEqual([
        [{ data: [completion], skipDuplicates: true }],
      ]);
    });

    it.each([
      ['a skipped or unfinished step', 4, 1],
      ['no steps', 0, 0],
    ])('records nothing with %s', async (_, steps, unfinished) => {
      const tx = txWith(steps, unfinished);
      await expect(recordVerifiedCompletion(tx, completion)).resolves.toBe(
        false,
      );
      expect(tx.makeupCompletion.createMany.mock.calls).toEqual([]);
    });

    it('reports a completion recorded before (repeated request) as not new', async () => {
      const tx = txWith(2, 0);
      tx.makeupCompletion.createMany.mockResolvedValue({ count: 0 });
      await expect(recordVerifiedCompletion(tx, completion)).resolves.toBe(
        false,
      );
    });
  });
});
