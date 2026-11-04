export function normalizePhone(phone: string): string {
  if (!phone) return '';
  return phone
    .replace(/[\s\-\(\)\.]/g, '')
    .replace(/^\+66/, '0');
}

export function isValidThaiPhone(phone: string): boolean {
  const normalized = normalizePhone(phone);
  return /^0\d{8,9}$/.test(normalized);
}
