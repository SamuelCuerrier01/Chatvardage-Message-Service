import { UnauthorizedException } from '@nestjs/common';
import { JwtAuthService } from './jwt-auth.service';

describe('JwtAuthService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('extracts a Bearer token', () => {
    expect(new JwtAuthService().bearerToken('Bearer abc')).toBe('abc');
    expect(() => new JwtAuthService().bearerToken('Basic abc')).toThrow(
      UnauthorizedException,
    );
  });

  it('validates the token through Auth', async () => {
    const user = {
      id: 'u1',
      pseudo: 'alice',
      courriel: 'alice@example.com',
      role: 'utilisateur',
    };
    global.fetch = jest.fn(() =>
      Promise.resolve(new Response(JSON.stringify(user), { status: 200 })),
    );

    await expect(new JwtAuthService().verifyToken('jwt')).resolves.toEqual(
      user,
    );
    await expect(new JwtAuthService().verifyTokenFresh('jwt')).resolves.toEqual(
      user,
    );
  });
});
