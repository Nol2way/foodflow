import { read, utils } from 'xlsx'
import { InputError } from './validation.ts'

export function xlsxCsv(base64: unknown): string {
  if (typeof base64 !== 'string' || base64.length > 4_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new InputError(413, 'invalid_workbook')
  let bytes: Uint8Array
  try { bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0)) } catch { throw new InputError(400, 'invalid_workbook') }
  // XLSX is ZIP. Check central directory declarations before decompression.
  const view = new DataView(bytes.buffer)
  let end = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break }
  }
  if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw new InputError(400, 'invalid_workbook')
  const entries = view.getUint16(end + 10, true)
  let offset = view.getUint32(end + 16, true), total = 0
  if (!entries || entries > 200 || offset >= end) throw new InputError(413, 'workbook_too_large')
  for (let n = 0; n < entries; n++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw new InputError(400, 'invalid_workbook')
    const size = view.getUint32(offset + 24, true), compressed = view.getUint32(offset + 20, true)
    const local = view.getUint32(offset + 42, true)
    total += size
    if (total > 20_000_000 || size === 0xffffffff || compressed === 0xffffffff) throw new InputError(413, 'workbook_too_large')
    if (local + 30 > offset || view.getUint32(local, true) !== 0x04034b50) throw new InputError(400, 'invalid_workbook')
    const nameSize = view.getUint16(local + 26, true), extraSize = view.getUint16(local + 28, true)
    if (local + 30 + nameSize + extraSize + compressed > offset) throw new InputError(400, 'invalid_workbook')
    const checkExtra = (start: number, length: number) => {
      for (let i = start; i < start + length;) {
        if (i + 4 > start + length || view.getUint16(i, true) === 1) throw new InputError(400, 'zip64_not_supported')
        i += 4 + view.getUint16(i + 2, true)
        if (i > start + length) throw new InputError(400, 'invalid_workbook')
      }
    }
    checkExtra(local + 30 + nameSize, extraSize)
    const centralName = view.getUint16(offset + 28, true), centralExtra = view.getUint16(offset + 30, true)
    if (offset + 46 + centralName + centralExtra + view.getUint16(offset + 32, true) > end) throw new InputError(400, 'invalid_workbook')
    checkExtra(offset + 46 + centralName, centralExtra)
    // SheetJS allocates from the local header. Bind it to the checked directory size,
    // including streaming ZIPs whose local header carries zero until the descriptor.
    view.setUint32(local + 18, compressed, true)
    view.setUint32(local + 22, size, true)
    if (!size && compressed > 2) throw new InputError(400, 'invalid_workbook')
    offset += 46 + centralName + centralExtra + view.getUint16(offset + 32, true)
  }
  try {
    const book = read(bytes, { type: 'array', cellFormula: true, cellDates: false, sheetRows: 20002 })
    if (book.SheetNames.length !== 1) throw new InputError(400, 'single_sheet_required')
    const sheet = book.Sheets[book.SheetNames[0]]
    const range = utils.decode_range(sheet['!fullref'] ?? sheet['!ref'] ?? 'A1')
    if (range.e.r >= 20001 || range.e.c >= 32) throw new InputError(413, 'workbook_too_large')
    for (const [key, cell] of Object.entries(sheet)) if (!key.startsWith('!') && cell?.f) throw new InputError(400, 'workbook_formulas_not_supported')
    return utils.sheet_to_csv(sheet, { blankrows: false })
  } catch (e) {
    if (e instanceof InputError) throw e
    throw new InputError(400, 'invalid_workbook')
  }
}
