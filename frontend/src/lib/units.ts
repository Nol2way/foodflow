// หน่วยนับ (0024): หน่วยกลางของร้าน + หน่วยแปลงต่อวัตถุดิบ (1 ลัง = 10 kg)
// สต็อกเก็บเป็นหน่วยหลักของวัตถุดิบเสมอ หน่วยแปลงใช้ตอนกรอก (รับของ / ตรวจนับ) แล้วแปลงก่อนส่ง
import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'

export const DEFAULT_UNITS = ['kg', 'g', 'ลิตร', 'ml', 'ตัว', 'ชิ้น', 'แพ็ค', 'ถุง', 'กล่อง', 'ลัง', 'ขวด', 'กระป๋อง']

export interface PackUnit {
  unit_name: string
  factor: number // 1 unit_name = factor หน่วยหลัก
}

export interface UnitRow {
  id: string
  name: string
}

export function useUnits(restaurantId: string) {
  const [rows, setRows] = useState<UnitRow[]>([])
  const reload = useCallback(async () => {
    const { data, error } = await supabase
      .from('units')
      .select('id,name')
      .eq('restaurant_id', restaurantId)
      .order('sort_order')
      .order('name')
    setRows(error ? [] : ((data ?? []) as UnitRow[]))
  }, [restaurantId])
  useEffect(() => {
    void reload()
  }, [reload])
  // ยังไม่ได้รัน 0024: ใช้รายการเริ่มต้น
  const names = rows.length ? rows.map((r) => r.name) : DEFAULT_UNITS
  return { rows, names, reload }
}

// หน่วยแปลงของทุกวัตถุดิบที่ผู้ใช้เห็น (RLS กรองเฉพาะร้านตัวเอง)
export function usePackUnits() {
  const [map, setMap] = useState<Map<string, PackUnit[]>>(new Map())
  const reload = useCallback(async () => {
    const { data, error } = await supabase.from('ingredient_units').select('ingredient_id,unit_name,factor').order('factor', { ascending: false })
    const m = new Map<string, PackUnit[]>()
    if (!error) {
      for (const r of data ?? []) {
        const list = m.get(r.ingredient_id) ?? []
        list.push({ unit_name: r.unit_name, factor: Number(r.factor) })
        m.set(r.ingredient_id, list)
      }
    }
    setMap(m)
  }, [])
  useEffect(() => {
    void reload()
  }, [reload])
  return { map, reload }
}

// บันทึกหน่วยแปลงทั้งชุดของวัตถุดิบ 1 ตัว (ลบของเดิมแล้วใส่ใหม่)
export async function savePackUnits(ingredientId: string, packs: PackUnit[]): Promise<string | null> {
  const del = await supabase.from('ingredient_units').delete().eq('ingredient_id', ingredientId)
  if (del.error) return del.error.message
  const rows = packs.filter((p) => p.unit_name.trim() && p.factor > 0)
  if (!rows.length) return null
  const ins = await supabase.from('ingredient_units').insert(rows.map((p) => ({ ingredient_id: ingredientId, unit_name: p.unit_name.trim(), factor: p.factor })))
  return ins.error?.message ?? null
}

export const fmtFactor = (n: number) => Number(n).toLocaleString('th-TH', { maximumFractionDigits: 4 })
