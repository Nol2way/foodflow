export function tableLayout(tables: { id: string; floor_x: number; floor_y: number }[]) {
  const occupied = new Set<string>()
  return [...tables].sort((a, b) => Number(a.floor_y) - Number(b.floor_y) || Number(a.floor_x) - Number(b.floor_x) || a.id.localeCompare(b.id)).map(table => {
    const percent = (value: number) => Number.isFinite(Number(value)) ? Math.max(0, Math.min(100, Number(value))) : 0
    const column = Math.min(5, Math.floor(percent(table.floor_x) / 100 * 6)) + 1
    let row = Math.floor(percent(table.floor_y) / 100 * 5) + 1
    while (occupied.has(`${row}:${column}`)) row++
    occupied.add(`${row}:${column}`)
    return { id: table.id, column, row }
  })
}
