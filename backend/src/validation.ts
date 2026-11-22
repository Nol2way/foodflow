export class InputError extends Error {
  status: 400 | 413
  constructor(status: 400 | 413, message: string) { super(message); this.status = status }
}

export const validDate = (v: unknown): v is string => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const d = new Date(v + 'T00:00:00Z')
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v
}

export function money(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 100_000_000 || Math.abs(v * 100 - Math.round(v * 100)) > 0.00001) {
    throw new InputError(400, 'invalid_amount')
  }
  return v
}

export function optionalText(v: unknown, max: number): string | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v !== 'string' || v.trim().length > max) throw new InputError(400, 'invalid_request')
  return v.trim() || null
}
