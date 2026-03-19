export function extractVirtualKeyToken(input) {
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