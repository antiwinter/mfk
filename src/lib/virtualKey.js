const LEGACY_PREFIX = 'sk-mfk-';
const STYLE_PREFIX = 'mfk-';

export function parseVirtualKey(input) {
  const token = extractToken(input);

  if (token.startsWith(LEGACY_PREFIX)) {
    const username = token.slice(LEGACY_PREFIX.length);
    if (!username) {
      throw new Error('Virtual key username is empty');
    }

    return {
      token,
      username,
      style: 'openai',
    };
  }

  if (token.startsWith(STYLE_PREFIX)) {
    const match = token.match(/^mfk-([a-z0-9]+)-(.+)$/i);
    if (!match) {
      throw new Error('Style virtual key must match mfk-<style>-<username>');
    }

    return {
      token,
      style: match[1].toLowerCase(),
      username: match[2],
    };
  }

  throw new Error('Virtual key must start with sk-mfk- or mfk-<style>-');
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