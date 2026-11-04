export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('FATAL: JWT_SECRET must be defined and at least 32 characters long.');
  }
  return secret;
}

export function getCorsOrigins(): string[] {
  const envOrigins = process.env.CORS_ORIGINS;
  if (!envOrigins) {
    return ['http://localhost:3000'];
  }
  return envOrigins
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}
