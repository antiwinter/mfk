const LEGACY_PREFIX = 'sk-mfk-';

export function parseVirtualKey(authHeader) {
  if (!authHeader) {
    throw new Error('Missing Authorization header');
  }

  const [scheme, token] = authHeader.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    throw new Error('Authorization header must use Bearer authentication');
  }

  if (!token.startsWith(LEGACY_PREFIX)) {
    throw new Error('Virtual key must start with sk-mfk-');
  }

  const username = token.slice(LEGACY_PREFIX.length);
  if (!username) {
    throw new Error('Virtual key username is empty');
  }

  return {
    token,
    username,
  };
}