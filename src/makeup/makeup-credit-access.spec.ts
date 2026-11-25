import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import {
  CREDITS_REQUIRED_KEY,
  ProAccessGuard,
} from '../subscription/pro-access.guard';
import { MakeupController } from './makeup.controller';

/**
 * Credit eligibility applies exclusively to POST /v1/sessions: every other
 * makeup route stays open to any authenticated user.
 */
describe('MakeupController credit access', () => {
  const handlers = Object.getOwnPropertyNames(MakeupController.prototype)
    .filter((name) => name !== 'constructor')
    .map((name) => {
      const handler = (
        MakeupController.prototype as unknown as Record<string, object>
      )[name];
      return {
        name,
        method: Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod,
        path: Reflect.getMetadata(PATH_METADATA, handler) as string,
        guards: (Reflect.getMetadata(GUARDS_METADATA, handler) ??
          []) as unknown[],
        creditsRequired: Reflect.getMetadata(CREDITS_REQUIRED_KEY, handler) as
          | boolean
          | undefined,
      };
    })
    .filter((route) => route.path !== undefined);

  it('guards POST /v1/sessions with ProAccessGuard in credit mode', () => {
    const create = handlers.find(
      (route) =>
        route.method === RequestMethod.POST && route.path === 'sessions',
    );
    expect(create).toMatchObject({
      name: 'createSession',
      guards: [ProAccessGuard],
      creditsRequired: true,
    });
  });

  it('leaves every other makeup route without the credit requirement or ProAccessGuard', () => {
    const others = handlers.filter((route) => route.name !== 'createSession');
    expect(others.length).toBeGreaterThan(10);
    for (const route of others) {
      expect([route.name, route.creditsRequired, route.guards]).toEqual([
        route.name,
        undefined,
        [],
      ]);
    }
  });
});
