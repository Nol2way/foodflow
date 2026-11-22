import type { Env } from './env.ts'

// This is the minimum API-visible contract required by this release, not a claim
// that migration history, RLS policies or production acceptance checks were audited.
export const REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  app_users: ['credential_version'],
  menu_items: ['option_choices'],
  order_items: ['options_snapshot'],
  orders: ['client_ref', 'client_payload', 'is_split', 'bill_requested_at', 'service_charge', 'tip'],
  dining_tables: ['floor_x', 'floor_y', 'zone', 'seats'],
  shop_settings: ['kitchen_warn_minutes', 'kitchen_auto_print', 'kitchen_sound', 'morning_report_enabled', 'morning_report_hour'],
  promotions: ['coupon_code', 'stackable'],
  feedback: ['rating', 'client_ref', 'restaurant_id'],
}

export const REQUIRED_RPCS: Record<string, readonly string[]> = {
  app_session_valid: ['p_user_id', 'p_credential_version', 'p_password_change'],
  app_session_current: [], app_logout: ['p_user_id'],
  app_change_password: ['p_user_id', 'p_current_password', 'p_new_password', 'p_credential_version'],
  app_auth_allow: ['p_key', 'p_limit', 'p_window_seconds'],
  app_update_profile: ['p_user_id', 'p_set_display_name', 'p_set_phone'],
  import_sales_history: ['p_restaurant_id', 'p_rows', 'p_preview_token'],
  save_promotion: ['p_restaurant_id', 'p_promotion_id', 'p_values', 'p_item_ids'],
  acct_journal_export: ['p_restaurant_id', 'p_from', 'p_to'],
  acct_expense_export: ['p_restaurant_id', 'p_from', 'p_to'],
  acct_trial_balance_export: ['p_restaurant_id', 'p_from', 'p_to'],
  acct_menu_profit_export: ['p_restaurant_id', 'p_from', 'p_to'],
  tax_document_export: ['p_restaurant_id', 'p_from', 'p_to'],
  tax_documents_list: ['p_restaurant_id', 'p_from', 'p_to', 'p_doc_type', 'p_status', 'p_order_id'],
  daily_report_targets: ['p_scheduled_at'], report_dispatch_claim: ['p_restaurant_id', 'p_report_date'],
  report_dispatch_finish: ['p_restaurant_id', 'p_report_date', 'p_success'],
  staff_place_order: ['p_restaurant_id', 'p_items', 'p_client_ref'],
  counter_pay_bill: ['p_restaurant_id', 'p_order_ids', 'p_expected_total'],
  table_move_orders: ['p_restaurant_id', 'p_source_table_id', 'p_target_table_id'],
  table_request_bill: ['p_restaurant_id', 'p_table_id'],
  order_set_charges: ['p_order_id', 'p_service_charge', 'p_tip'],
  staff_edit_order: ['p_order_id', 'p_items', 'p_note'],
  staff_split_order: ['p_order_id', 'p_item_ids'],
  audit_events: ['p_restaurant_id', 'p_before', 'p_limit'],
  coupon_lookup: ['p_restaurant_id', 'p_code'], promo_report: ['p_restaurant_id', 'p_from', 'p_to'],
  member_find: ['p_restaurant_id', 'p_phone'], member_export: ['p_restaurant_id', 'p_member_id'], member_delete: ['p_restaurant_id', 'p_member_id'],
  submit_feedback: ['p_restaurant_id', 'p_rating', 'p_client_ref'], feedback_report: ['p_restaurant_id', 'p_from', 'p_to'],
  morning_report_targets: ['p_scheduled_at'], morning_stock_data: ['p_restaurant_id', 'p_date'],
  morning_dispatch_claim: ['p_restaurant_id', 'p_report_date'], morning_dispatch_finish: ['p_restaurant_id', 'p_report_date', 'p_success'],
  report_dispatch_pending: ['p_morning'], day_close_dispatch_pending: [],
  day_close_dispatch_claim: ['p_restaurant_id', 'p_report_date'], day_close_dispatch_finish: ['p_restaurant_id', 'p_report_date', 'p_success'],
  staff_set_active: ['p_restaurant_id', 'p_user_id', 'p_active'], staff_reset_password: ['p_restaurant_id', 'p_user_id', 'p_password'],
  tax_doc_create: ['p_doc_type', 'p_client_ref'], acct_close_day: ['p_restaurant_id', 'p_date', 'p_counted_cash', 'p_notify'],
}

type FailureCode = 'database_not_configured' | 'database_access_denied' | 'database_unavailable' | 'schema_metadata_unavailable' | 'schema_not_ready'
export type Readiness = { ok: true; ready: true; schema_version: '0011'; error?: never }
  | { ok: false; ready: false; error: FailureCode; required_schema?: '0011' }
type ObjectValue = Record<string, unknown>
const object = (v: unknown): ObjectValue => v && typeof v === 'object' && !Array.isArray(v) ? v as ObjectValue : {}

function resolve(root: ObjectValue, value: unknown): ObjectValue {
  const s = object(value)
  if (typeof s.$ref !== 'string' || !s.$ref.startsWith('#/')) return s
  let current: unknown = root
  for (const key of s.$ref.slice(2).split('/')) current = object(current)[key.replace(/~1/g, '/').replace(/~0/g, '~')]
  return object(current)
}

export function schemaContractMatches(input: unknown): boolean {
  const root = object(input), definitions = object(root.definitions), paths = object(root.paths)
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const properties = object(resolve(root, definitions[table]).properties)
    if (!columns.every(column => Object.hasOwn(properties, column))) return false
  }
  for (const [name, args] of Object.entries(REQUIRED_RPCS)) {
    const operation = object(object(paths['/rpc/' + name]).post)
    if (!Object.keys(operation).length) return false
    if (!args.length) continue
    const parameters = Array.isArray(operation.parameters) ? operation.parameters : []
    const body = parameters.map(value => resolve(root, value)).find(value => value.in === 'body')
    const properties = object(resolve(root, body?.schema).properties)
    if (!args.every(arg => Object.hasOwn(properties, arg))) return false
  }
  return true
}

export async function checkSchemaReadiness(env: Env): Promise<Readiness> {
  const fail = (error: FailureCode): Readiness => ({ ok: false, ready: false, error, ...(error === 'schema_not_ready' ? { required_schema: '0011' as const } : {}) })
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.SUPABASE_ANON_KEY || !env.SUPABASE_JWT_SECRET) return fail('database_not_configured')
  let url: URL
  try { url = new URL(env.SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/'); if (!['http:', 'https:'].includes(url.protocol)) return fail('database_not_configured') } catch { return fail('database_not_configured') }
  try {
    // GET the PostgREST schema cache, never SELECT rows or invoke a business RPC.
    // Service metadata includes callable functions and readable table definitions.
    const response = await fetch(url.toString(), {
      method: 'GET', headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, Accept: 'application/openapi+json' },
      signal: AbortSignal.timeout(8_000),
    })
    if (response.status === 401 || response.status === 403) return fail('database_access_denied')
    if (!response.ok) return fail(response.status >= 500 || response.status === 429 ? 'database_unavailable' : 'schema_metadata_unavailable')
    let schema: unknown
    try { schema = await response.json() } catch { return fail('schema_metadata_unavailable') }
    const root = object(schema)
    if (root.swagger !== '2.0' || !root.definitions || !root.paths) return fail('schema_metadata_unavailable')
    if (!schemaContractMatches(schema)) return fail('schema_not_ready')
    // A cached OpenAPI document alone cannot prove the database is reachable or
    // that the reported missing column really exists behind a stale schema cache.
    // HEAD + limit=0 executes no business-row read and returns no response body.
    const probe = new URL('order_items?select=options_snapshot&limit=0', url)
    const live = await fetch(probe.toString(), {
      method: 'HEAD', headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
      signal: AbortSignal.timeout(8_000),
    })
    if (live.status === 401 || live.status === 403) return fail('database_access_denied')
    if (!live.ok) return fail(live.status >= 500 || live.status === 429 ? 'database_unavailable' : 'schema_not_ready')
    return { ok: true, ready: true, schema_version: '0011' }
  } catch { return fail('database_unavailable') }
}
