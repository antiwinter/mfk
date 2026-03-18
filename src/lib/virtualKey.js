const LEGACY_PREFIX = 'sk-mfk-';
const SHORT_PREFIX = 'mfk-';

export function parseVirtualKey(input) {
  const token = extractToken(input);

  if (token.startsWith(LEGACY_PREFIX)) {
    const username = token.slice(LEGACY_PREFIX.length);
    if (!username) {
      throw new Error('Virtual key username is empty');
    }

    return { token, username };
  }

  if (token.startsWith(SHORT_PREFIX)) {
    const username = token.slice(SHORT_PREFIX.length);
    if (!username) {
      throw new Error('Virtual key username is empty');
    }

    return { token, username };
  }

  throw new Error('Virtual key must start with sk-mfk- or mfk-');
}

function extractToken(input) {
  if (!input) {
    throw new Error('Missing authentication token');
  }

  if (typeof input === 'string') {
    return extractTokenFromHeader(input);
  }

  const headerKey = input['x-api-key'] ?? input['X-API-Key'] ?? input.authorization ?? input.Authorization;
  if (!headerKey) {
    throw new Error('Missing authentication header');
  }

  if (String(headerKey).toLowerCase().startsWith('bearer ')) {
    return extractTokenFromHeader(String(headerKey));
  }

  return String(headerKey).trim();
}

function extractTokenFromHeader(authHeader) {
  const [scheme, token] = authHeader.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    throw new Error('Authorization header must use Bearer authentication');
  }

  return token;
}