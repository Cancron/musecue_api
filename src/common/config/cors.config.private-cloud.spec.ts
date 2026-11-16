import { createCorsOptions } from './cors.config';

describe('createCorsOptions (used by main.ts)', () => {
  it('uses the configured origin list, which makes CORS answer Vary: Origin', () => {
    expect(
      createCorsOptions(
        ' https://app.musecue.example , http://localhost:8081 ,',
      ),
    ).toEqual({
      origin: ['https://app.musecue.example', 'http://localhost:8081'],
      credentials: true,
    });
  });

  it.each([undefined, '', ' , '])(
    'falls back to the local development origins for %p',
    (value) => {
      expect(createCorsOptions(value)).toEqual({
        origin: ['http://localhost:8081', 'http://localhost:19006'],
        credentials: true,
      });
    },
  );
});
