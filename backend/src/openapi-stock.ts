// เอกสาร OpenAPI ของโมดูลสต็อกวัตถุดิบ (รวมเข้า openapi.ts) · route อยู่ที่ src/stock.ts

const uuid = { type: 'string', format: 'uuid' } as const
const date = { type: 'string', format: 'date', examples: ['2026-10-26'] } as const
const qty = { type: 'number', description: 'หน่วยฐานของวัตถุดิบ (g / ml / pcs)' } as const
const money = { type: 'number', description: 'บาท' } as const
const bearer = [{ bearerAuth: [] }]
const errRef = { $ref: '#/components/schemas/Error' }
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const json = (schema: object) => ({ 'application/json': { schema } })
const q = (name: string, schema: object, description: string, required = true) => ({ name, in: 'query', required, schema, description })
const restaurant = q('restaurant_id', uuid, 'ร้านที่ทำรายการ')
const path = (name: string, description: string) => ({ name, in: 'path', required: true, schema: uuid, description })
const obj = (properties: Record<string, object>, required: string[] = []) => ({ type: 'object', required, properties })
const arr = (items: object) => ({ type: 'array', items })

const errors = (extra: Record<string, string> = {}) => ({
  '400': { description: 'ข้อมูลไม่ถูกต้อง (invalid_field + field, invalid_lines, invalid_range ...)', content: json(errRef) },
  '401': { description: 'ไม่ได้ล็อกอิน', content: json(errRef) },
  '403': { description: 'บทบาทไม่พอ หรือเป็นข้อมูลของร้านอื่น', content: json(errRef) },
  ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, { description: v, content: json(errRef) }])),
})
const ok = (description: string, schema: object, status = '200') => ({ [status]: { description, content: json(schema) } })
const body = (schema: object) => ({ required: true, content: json(schema) })
const op = (summary: string, who: string, operationId: string, rest: object) => ({
  tags: ['สต็อกวัตถุดิบ'],
  summary,
  description: `สิทธิ์: ${who}`,
  operationId,
  security: bearer,
  ...rest,
})

const READ = 'เจ้าของ ผู้จัดการ พนักงานสต็อก พนักงานบัญชี (อ่านอย่างเดียว)'
const WRITE = 'เจ้าของ ผู้จัดการ พนักงานสต็อก'
const APPROVE = 'เจ้าของ ผู้จัดการ'

export const stockTag = {
  name: 'สต็อกวัตถุดิบ',
  description: [
    'ยอดคงเหลือ = ผลรวมของ ledger (stock_movements) แก้ตรงไม่ได้ · ledger เพิ่มได้อย่างเดียว ผิดให้กลับรายการ',
    'สต็อกมี 3 แหล่ง: **นำเข้า** · **ตัดตามสูตร** (อัตโนมัติเมื่อครัวกดเริ่มทำ คืนเมื่อยกเลิก) · **นับสุดท้าย** (ไม่มีการบันทึกของเสียแยก)',
    'หยิบของแบบ **FEFO** คิดต้นทุนแบบ **FIFO** ตามล็อต · หน่วยฐานทุกตัวเลข: g / ml / pcs',
    'Actual vs Theoretical: ยอดที่ควรเหลือ = นับรอบก่อน + นำเข้า − ตัดตามสูตร · ส่วนต่าง = นับจริง − ยอดที่ควรเหลือ',
    'ข้อผิดพลาดจากกฎสต็อกตอบ `{ error: "<code>", message: "<ไทย>" }` เช่น `insufficient_stock` (409), `lot_already_used` (409)',
  ].join('\n'),
}

const Ingredient = obj({
  id: uuid, name: { type: 'string' }, recipe_unit: { type: 'string', enum: ['g', 'ml', 'pcs'] },
  unit: { type: 'string', description: 'ชื่อหน่วยฐานที่แสดง (pcs ใช้ชื่อร้าน เช่น ฟอง)' },
  quantity_on_hand: { ...qty, description: 'คงเหลือ = ผลรวม ledger (อ่านอย่างเดียว)' },
  cost_per_unit: { type: 'number', description: 'ต้นทุนเฉลี่ยของชั้น FIFO ที่เหลือ ต่อหน่วยฐาน (อ่านอย่างเดียว)' },
  last_unit_cost: { type: 'number', description: 'ราคาซื้อล่าสุดต่อหน่วยฐาน ใช้คิดต้นทุนสูตร (อ่านอย่างเดียว)' },
  purchase_unit: { type: 'string', examples: ['kg'] }, conversion_factor: { type: 'number', description: '1 หน่วยซื้อ = ? หน่วยฐาน' },
  display_unit: { type: ['string', 'null'], examples: ['ถุง'] }, display_factor: { type: 'number', description: '1 หน่วยครัว = ? หน่วยฐาน' },
  trim_yield_pct: { type: 'number' }, cook_yield_pct: { type: 'number', description: 'หลังปรุง (ข้าวหุงสุกเกิน 100 ได้)' },
  abc_class: { type: 'string', enum: ['A', 'B', 'C'] }, storage_location: { type: ['string', 'null'] }, shelf_order: { type: 'integer' },
  reorder_level: qty, par_level: { type: ['number', 'null'], description: 'ว่าง = คำนวณให้' }, safety_stock: qty,
  supplier_id: { type: ['string', 'null'], format: 'uuid' }, is_active: { type: 'boolean' },
})

const IngredientInput = obj({
  restaurant_id: uuid, name: { type: 'string', maxLength: 100 },
  recipe_unit: { type: 'string', enum: ['g', 'ml', 'pcs'], description: 'สร้างใหม่เท่านั้น (เปลี่ยนไม่ได้หลังมีประวัติ)' },
  unit: { type: 'string', description: 'ชื่อหน่วยของ pcs เช่น ฟอง' },
  quantity_on_hand: { ...qty, description: 'สร้างใหม่เท่านั้น: ยอดยกมา -> บันทึกเป็นรายการ count_adjust + ล็อตแรก' },
  cost_per_unit: { type: 'number', description: 'สร้างใหม่เท่านั้น: ราคาเริ่มต้นต่อหน่วยฐาน' },
  purchase_unit: { type: 'string' }, conversion_factor: { type: 'number' }, display_unit: { type: 'string' }, display_factor: { type: 'number' },
  trim_yield_pct: { type: 'number', minimum: 0.01, maximum: 100 }, cook_yield_pct: { type: 'number', minimum: 0.01, maximum: 400 },
  abc_class: { type: 'string', enum: ['A', 'B', 'C'] }, storage_location: { type: 'string' }, shelf_order: { type: 'integer' },
  reorder_level: qty, par_level: { type: ['number', 'null'] }, safety_stock: qty, supplier_id: { type: ['string', 'null'], format: 'uuid' },
  is_active: { type: 'boolean' },
}, ['restaurant_id'])

const Supplier = obj({
  id: uuid, name: { type: 'string' }, phone: { type: ['string', 'null'] }, lead_time_days: { type: 'integer' },
  delivery_days: { ...arr({ type: 'integer', minimum: 0, maximum: 6 }), description: '0 = อาทิตย์ .. 6 = เสาร์' },
  note: { type: ['string', 'null'] }, is_active: { type: 'boolean' },
})

const RecipeLine = obj({
  ingredient_id: { type: ['string', 'null'], format: 'uuid' }, sub_recipe_id: { type: ['string', 'null'], format: 'uuid' },
  qty: { type: 'number', description: 'สุทธิที่ใช้จริง (หน่วยฐาน) หรือหน่วยที่ได้ของสูตรย่อย' },
})
const Recipe = obj({
  id: uuid, name: { type: 'string' }, menu_item_id: { type: ['string', 'null'], format: 'uuid', description: 'ว่าง = สูตรย่อย' },
  output_qty: { type: 'number' }, output_unit: { type: 'string' },
  cost_per_output: { type: 'number', description: 'ต้นทุนต่อ 1 หน่วยที่ได้ = Σ สุทธิ x ราคาซื้อ ÷ (trim x cook) รวมสูตรย่อย' },
  recipe_lines: arr(RecipeLine),
})
const RecipeInput = obj({
  restaurant_id: uuid, name: { type: 'string' }, menu_item_id: { type: ['string', 'null'], format: 'uuid' },
  output_qty: { type: 'number', exclusiveMinimum: 0 }, output_unit: { type: 'string' }, note: { type: 'string' }, lines: arr(RecipeLine),
}, ['restaurant_id', 'name', 'lines'])

const ReceiptLine = obj({
  ingredient_id: uuid,
  pack_qty: { type: 'number', description: 'แบบแพ็ค: จำนวนแพ็ค/ลัง' }, pack_size: { type: 'number', description: '1 แพ็ค = ? หน่วยฐาน' },
  pack_price: { ...money, description: 'ราคาต่อแพ็ค' },
  quantity: { ...qty, description: 'หรือกรอกเป็นหน่วยฐานตรงๆ' }, unit_cost: { type: 'number', description: 'บาทต่อหน่วยฐาน' },
  expiry_date: date, invoice_qty: { ...qty, description: 'ตามบิล (ถ้าไม่ตรงกับที่รับจริง)' }, note: { type: 'string' },
}, ['ingredient_id'])

const Warning = obj({
  ingredient_id: uuid, ingredient_name: { type: 'string' }, price_change_pct: { type: ['number', 'null'] },
  prev_unit_cost: { type: ['number', 'null'] }, unit_cost: { type: 'number' }, pack_changed: { type: 'boolean' },
  prev_pack_size: { type: ['number', 'null'] }, pack_size: { type: ['number', 'null'] },
})

const VarianceLine = obj({
  ingredient_id: uuid, ingredient_name: { type: 'string' }, unit: { type: 'string' }, display_unit: { type: ['string', 'null'] },
  display_factor: { type: 'number' }, abc_class: { type: 'string' },
  opening_qty: { ...qty, description: 'นับรอบก่อน' }, received_qty: { ...qty, description: 'นำเข้าระหว่างรอบ' },
  deducted_qty: { ...qty, description: 'ตัดตามสูตรสุทธิ (หักคืนแล้ว)' }, expected_qty: { ...qty, description: 'ยอดที่ควรเหลือ' },
  counted_qty: qty, variance_qty: { ...qty, description: 'นับจริง − ควรเหลือ (ติดลบ = ของหายไม่ทราบสาเหตุ)' },
  variance_value: money, variance_pct: { type: ['number', 'null'] },
  color: { type: 'string', enum: ['green', 'yellow', 'red'], description: 'เขียว < 2% · เหลือง 2-5% · แดง > 5% ของยอดที่ควรเหลือ' },
  negative_streak: { type: 'integer' }, recipe_alert: { type: 'boolean', description: 'ติดลบต่อเนื่อง 3 รอบ: สูตรหรือ yield อาจไม่ตรง' },
  note: { type: ['string', 'null'] }, entered_text: { type: ['string', 'null'] },
})

const Movement = obj({
  id: uuid, created_at: { type: 'string', format: 'date-time' }, ingredient_id: uuid, ingredient_name: { type: 'string' }, unit: { type: 'string' },
  type: { type: 'string', enum: ['receive', 'recipe_deduct', 'recipe_return', 'count_adjust', 'legacy'] },
  change: qty, balance_after: qty, cost: { ...money, description: 'มูลค่าตามต้นทุน FIFO' }, unit_cost: { type: 'number' },
  note: { type: ['string', 'null'] }, actor_id: { type: ['string', 'null'], format: 'uuid' }, actor_name: { type: ['string', 'null'] },
  ref_id: { type: ['string', 'null'], format: 'uuid' }, order_label: { type: ['string', 'null'] },
  reverses_id: { type: ['string', 'null'], format: 'uuid' }, reversed_by: { type: ['string', 'null'], format: 'uuid' },
})

const Reorder = obj({
  ingredient_id: uuid, name: { type: 'string' }, unit: { type: 'string' }, on_hand: qty, daily_usage: qty,
  lead_time_days: { type: 'integer' }, cycle_days: { type: 'number', description: '7 ÷ จำนวนวันที่ผู้ขายมาส่งต่อสัปดาห์' },
  safety_stock: qty, par: { ...qty, description: 'ใช้ต่อวัน x (lead time + รอบสั่ง) + safety stock' },
  par_source: { type: 'string', enum: ['auto', 'manual'] }, suggested_qty: { ...qty, description: 'par − คงเหลือ' },
  purchase_unit: { type: 'string' }, conversion_factor: { type: 'number' }, suggested_purchase_qty: { type: 'number', description: 'ปัดขึ้นเป็นหน่วยซื้อ' },
  supplier_id: { type: ['string', 'null'], format: 'uuid' }, supplier_name: { type: ['string', 'null'] },
  order_today: { type: 'boolean', description: 'สั่งวันนี้แล้วของมาถึงในวันที่ผู้ขายมาส่ง' }, next_delivery: { type: ['string', 'null'], format: 'date' },
})

export const stockSchemas = {
  StockIngredient: Ingredient, StockIngredientInput: IngredientInput, StockSupplier: Supplier, StockRecipe: Recipe,
  StockRecipeInput: RecipeInput, StockReceiptLine: ReceiptLine, StockWarning: Warning, StockVarianceLine: VarianceLine,
  StockMovement: Movement, StockReorder: Reorder,
  StockOverview: obj({
    today: date, stock_value: { ...money, description: 'ผลรวมล็อต x ต้นทุน FIFO' }, ingredient_count: { type: 'integer' },
    out: arr(obj({ id: uuid, name: { type: 'string' }, unit: { type: 'string' } })),
    low: arr(obj({ id: uuid, name: { type: 'string' }, on_hand: qty, threshold: qty })),
    expiring: arr(obj({ lot_id: uuid, name: { type: 'string' }, qty, expiry_date: date, days_left: { type: 'integer' }, value: money })),
    reorder_today: arr(ref('StockReorder')),
    recipe_alerts: arr(obj({ ingredient_id: uuid, name: { type: 'string' }, streak: { type: 'integer' } })),
    stock_disabled_menus: arr(obj({ id: uuid, name: { type: 'string' } })),
    last_count: { type: ['object', 'null'] },
  }),
}

export const stockPaths = {
  '/api/stock/overview': {
    get: op('ภาพรวม: ใกล้หมด หมด ใกล้หมดอายุ มูลค่าสต็อก แนะนำสั่งวันนี้', READ, 'stockOverview', {
      parameters: [restaurant], responses: { ...ok('ภาพรวม', ref('StockOverview')), ...errors() },
    }),
  },
  '/api/stock/reorder': {
    get: op('Par และจำนวนแนะนำสั่งทุกวัตถุดิบ', READ, 'stockReorder', {
      parameters: [restaurant, q('days', { type: 'integer', minimum: 1, maximum: 365, default: 28 }, 'ใช้ยอดใช้ย้อนหลังกี่วันคิดใช้ต่อวัน', false)],
      responses: { ...ok('รายการแนะนำ', obj({ suggestions: arr(ref('StockReorder')) })), ...errors() },
    }),
  },
  '/api/stock/ingredients': {
    get: op('รายการวัตถุดิบพร้อมยอดคงเหลือ', READ, 'stockIngredients', {
      parameters: [restaurant, q('include_inactive', { type: 'boolean' }, 'รวมที่ปิดใช้งาน', false)],
      responses: { ...ok('วัตถุดิบ', obj({ ingredients: arr(ref('StockIngredient')) })), ...errors() },
    }),
    post: op('เพิ่มวัตถุดิบ (ยอดยกมากลายเป็นรายการ ledger + ล็อตแรก)', WRITE, 'stockCreateIngredient', {
      requestBody: body(ref('StockIngredientInput')),
      responses: { ...ok('สร้างแล้ว', obj({ ingredient: ref('StockIngredient') }), '201'), ...errors({ '409': 'ชื่อซ้ำ (duplicate)' }) },
    }),
  },
  '/api/stock/ingredients/{id}': {
    patch: op('แก้ข้อมูลวัตถุดิบ (ยอด/ต้นทุนแก้ไม่ได้)', WRITE, 'stockUpdateIngredient', {
      parameters: [path('id', 'วัตถุดิบ')], requestBody: body(ref('StockIngredientInput')),
      responses: { ...ok('บันทึกแล้ว', obj({ ingredient: ref('StockIngredient') })), ...errors({ '404': 'ไม่พบ', '409': 'recipe_unit_locked' }) },
    }),
  },
  '/api/stock/suppliers': {
    get: op('รายชื่อผู้ขาย', READ, 'stockSuppliers', {
      parameters: [restaurant], responses: { ...ok('ผู้ขาย', obj({ suppliers: arr(ref('StockSupplier')) })), ...errors() },
    }),
    post: op('เพิ่มผู้ขาย', WRITE, 'stockCreateSupplier', {
      requestBody: body(obj({ restaurant_id: uuid, name: { type: 'string' }, phone: { type: 'string' }, lead_time_days: { type: 'integer' },
        delivery_days: arr({ type: 'integer' }), note: { type: 'string' } }, ['restaurant_id', 'name'])),
      responses: { ...ok('สร้างแล้ว', obj({ supplier: ref('StockSupplier') }), '201'), ...errors({ '409': 'ชื่อซ้ำ' }) },
    }),
  },
  '/api/stock/suppliers/{id}': {
    patch: op('แก้ผู้ขาย', WRITE, 'stockUpdateSupplier', {
      parameters: [path('id', 'ผู้ขาย')], requestBody: body(ref('StockSupplier')),
      responses: { ...ok('บันทึกแล้ว', obj({ supplier: ref('StockSupplier') })), ...errors({ '404': 'ไม่พบ' }) },
    }),
  },
  '/api/stock/recipes': {
    get: op('สูตรทั้งหมด (สูตรเมนู + สูตรย่อย) และเมนูที่ผูกได้', READ, 'stockRecipes', {
      parameters: [restaurant],
      responses: { ...ok('สูตร', obj({ recipes: arr(ref('StockRecipe')), menus: arr(obj({ id: uuid, name: { type: 'string' }, is_available: { type: 'boolean' },
        stock_disabled: { type: 'boolean' }, recipe_id: { type: ['string', 'null'] } })) })), ...errors() },
    }),
    post: op('สร้างสูตร (บันทึกทั้งสูตรในธุรกรรมเดียว คำนวณต้นทุนให้)', WRITE, 'stockCreateRecipe', {
      requestBody: body(ref('StockRecipeInput')),
      responses: { ...ok('สร้างแล้ว', obj({ recipe: ref('StockRecipe') }), '201'), ...errors({ '409': 'เมนูนี้มีสูตรแล้ว (duplicate)' }) },
    }),
  },
  '/api/stock/recipes/{id}': {
    put: op('แก้สูตร (แทนที่ทุกบรรทัด) · ต้นทุนสูตรนี้และสูตรแม่คำนวณใหม่', WRITE, 'stockUpdateRecipe', {
      parameters: [path('id', 'สูตร')], requestBody: body(ref('StockRecipeInput')),
      responses: { ...ok('บันทึกแล้ว', obj({ recipe: ref('StockRecipe') })), ...errors({ '404': 'ไม่พบ', '409': 'sub_recipe_in_use' }) },
    }),
    delete: op('ลบสูตร (สูตรย่อยที่ถูกใช้อยู่ลบไม่ได้)', WRITE, 'stockDeleteRecipe', {
      parameters: [path('id', 'สูตร'), restaurant], responses: { ...ok('ลบแล้ว', obj({ deleted: uuid })), ...errors({ '404': 'ไม่พบ' }) },
    }),
  },
  '/api/stock/last-purchases': {
    get: op('ราคา/ขนาดบรรจุครั้งล่าสุดต่อวัตถุดิบ (หน้ารับเข้าเตือนก่อนบันทึก)', READ, 'stockLastPurchases', {
      parameters: [restaurant, q('supplier_id', uuid, 'ผู้ขายเดียวกันก่อน', false)],
      responses: { ...ok('ราคาล่าสุด', obj({ last: arr(obj({ ingredient_id: uuid, unit_cost: { type: 'number' }, pack_size: { type: ['number', 'null'] },
        pack_price: { type: ['number', 'null'] }, supplier: { type: ['string', 'null'] }, received_on: date })) })), ...errors() },
    }),
  },
  '/api/stock/receipts': {
    get: op('ใบรับของในช่วงวันที่', READ, 'stockReceipts', {
      parameters: [restaurant, q('from', date, 'วันที่เริ่ม'), q('to', date, 'วันที่สิ้นสุด (ไม่เกิน 366 วัน)')],
      responses: { ...ok('ใบรับของ', obj({ receipts: arr({ type: 'object' }) })), ...errors() },
    }),
    post: op('รับเข้า: เลือกผู้ขาย จำนวน ราคา วันหมดอายุ -> ล็อต + เตือนราคา/ขนาดบรรจุเปลี่ยน', WRITE, 'stockReceive', {
      requestBody: body(obj({
        restaurant_id: uuid, supplier_id: uuid, invoice_no: { type: 'string' }, received_on: date, note: { type: 'string' },
        record_expense: { type: 'boolean', default: true, description: 'บันทึกเป็นรายจ่าย (บัญชี)' }, lines: arr(ref('StockReceiptLine')),
      }, ['restaurant_id', 'lines'])),
      responses: {
        ...ok('รับแล้ว', obj({ receipt_id: uuid, warnings: arr(ref('StockWarning')),
          recosted_recipes: { type: 'integer', description: 'จำนวนสูตรที่คำนวณต้นทุนใหม่ (รวมสูตรแม่)' } }), '201'),
        ...errors(),
      },
    }),
  },
  '/api/stock/count-sheet': {
    get: op('ใบนับแบบ blind (ไม่มียอดในระบบ) เรียงตามตำแหน่งจัดเก็บ', WRITE, 'stockCountSheet', {
      parameters: [restaurant, q('abc', { type: 'string', examples: ['A,B'] }, 'กรองคลาส ABC (คั่นด้วยจุลภาค)', false)],
      responses: { ...ok('รายการที่ต้องนับ', obj({ items: arr(obj({ ingredient_id: uuid, name: { type: 'string' }, recipe_unit: { type: 'string' },
        display_unit: { type: ['string', 'null'] }, display_factor: { type: 'number' }, abc_class: { type: 'string' },
        storage_location: { type: ['string', 'null'] }, shelf_order: { type: 'integer' } })) })), ...errors() },
    }),
  },
  '/api/stock/counts': {
    get: op('ใบนับล่าสุด 100 ใบ', READ, 'stockCounts', {
      parameters: [restaurant], responses: { ...ok('ใบนับ', obj({ counts: arr({ type: 'object' }) })), ...errors() },
    }),
    post: op('บันทึกใบนับ: ปรับยอดเป็นยอดนับจริง (count_adjust) และเก็บส่วนต่าง AvT', WRITE, 'stockSubmitCount', {
      requestBody: body(obj({
        restaurant_id: uuid, count_type: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'spot'] }, note: { type: 'string' },
        lines: arr(obj({ ingredient_id: uuid, counted_qty: qty, entered_text: { type: 'string', examples: ['2 ถุง + 250 g'] },
          note: { type: 'string', description: 'เหตุผล (ไม่บังคับ)' } }, ['ingredient_id', 'counted_qty'])),
      }, ['restaurant_id', 'lines'])),
      responses: { ...ok('บันทึกแล้ว', obj({ count_id: uuid }), '201'), ...errors() },
    }),
  },
  '/api/stock/counts/{id}/verify': {
    post: op('ผู้ตรวจรับรองใบนับ (ผู้จัดการรับรองใบที่ตัวเองนับไม่ได้)', APPROVE, 'stockVerifyCount', {
      parameters: [path('id', 'ใบนับ')], requestBody: body(obj({ restaurant_id: uuid }, ['restaurant_id'])),
      responses: { ...ok('รับรองแล้ว', obj({ verified: uuid })), ...errors({ '409': 'already_verified' }) },
    }),
  },
  '/api/stock/counts/{id}/variance': {
    get: op('รายงานส่วนต่างของใบนับ เรียงตามมูลค่า (หน่วย / บาท / % / สี)', READ, 'stockVariance', {
      parameters: [path('id', 'ใบนับ'), restaurant],
      responses: { ...ok('ส่วนต่าง', obj({ lines: arr(ref('StockVarianceLine')) })), ...errors() },
    }),
  },
  '/api/stock/yield-tests': {
    get: op('ผล yield test ย้อนหลัง', READ, 'stockYieldTests', {
      parameters: [restaurant, q('ingredient_id', uuid, 'เฉพาะวัตถุดิบ', false)],
      responses: { ...ok('ผลทดสอบ', obj({ tests: arr({ type: 'object' }) })), ...errors() },
    }),
    post: op('Yield test: ชั่งก่อน-หลัง 3 ครั้ง บันทึกค่าเฉลี่ย (เลือกนำไปใช้กับวัตถุดิบได้)', WRITE, 'stockRecordYieldTest', {
      requestBody: body(obj({
        restaurant_id: uuid, ingredient_id: uuid, kind: { type: 'string', enum: ['trim', 'cook'] },
        trials: { ...arr(obj({ before: qty, after: qty }, ['before', 'after'])), minItems: 3, maxItems: 3 },
        apply: { type: 'boolean', description: 'ตั้งค่าเฉลี่ยเป็น yield ของวัตถุดิบ -> ต้นทุนสูตรคำนวณใหม่' }, note: { type: 'string' },
      }, ['restaurant_id', 'ingredient_id', 'kind', 'trials'])),
      responses: { ...ok('บันทึกแล้ว', obj({ id: uuid, avg_pct: { type: 'number' }, applied: { type: 'boolean' } }), '201'), ...errors() },
    }),
  },
  '/api/stock/history': {
    get: op('ประวัติ ledger: กรองตามวัตถุดิบ วันที่ ผู้ทำรายการ ประเภท', READ, 'stockHistory', {
      parameters: [restaurant, q('from', date, 'วันที่เริ่ม (เวลาไทย)'), q('to', date, 'วันที่สิ้นสุด รวมวันนั้น (ไม่เกิน 366 วัน)'),
        q('ingredient_id', uuid, 'วัตถุดิบ', false), q('actor_id', uuid, 'ผู้ทำรายการ', false),
        q('type', { type: 'string', enum: ['receive', 'recipe_deduct', 'recipe_return', 'count_adjust', 'legacy'] }, 'ประเภท', false),
        q('limit', { type: 'integer', minimum: 1, maximum: 1000, default: 200 }, 'จำนวนสูงสุด', false)],
      responses: { ...ok('รายการ', obj({ movements: arr(ref('StockMovement')) })), ...errors() },
    }),
  },
  '/api/stock/movements/{id}/reverse': {
    post: op('กลับรายการนำเข้า/ปรับจากการนับ (ledger แก้ย้อนหลังไม่ได้)', APPROVE, 'stockReverseMovement', {
      parameters: [path('id', 'รายการ ledger')],
      requestBody: body(obj({ restaurant_id: uuid, reason: { type: 'string', maxLength: 180 } }, ['restaurant_id', 'reason'])),
      responses: { ...ok('สร้างรายการกลับแล้ว', obj({ reversal_id: uuid }), '201'), ...errors({ '409': 'already_reversed / lot_already_used' }) },
    }),
  },
}
