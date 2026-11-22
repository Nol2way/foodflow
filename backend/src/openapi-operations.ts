const uuid = { type: 'string', format: 'uuid' }
const rid = { name: 'restaurant_id', in: 'query', required: true, schema: uuid }
const id = { name: 'id', in: 'path', required: true, schema: uuid }
const response = { description: 'Operation result', content: { 'application/json': { schema: { type: 'object' } } } }
const responses = { '200': response, '201': response, '400': { description: 'Invalid input' }, '401': { description: 'Session invalid' }, '403': { description: 'Not authorized' }, '404': { description: 'Tenant object not found' }, '409': { description: 'State conflict' }, '502': { description: 'Dependency unavailable' } }
const get = (operationId: string, parameters: object[] = [rid]) => ({ operationId, security: [{ bearerAuth: [] }], parameters, responses })
const write = (operationId: string, properties: object, required: string[] = [], parameters: object[] = []) => ({ ...get(operationId, parameters), requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['restaurant_id', ...required], properties: { restaurant_id: uuid, ...properties } } } } } })
const dates = [rid, { name: 'from', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'to', in: 'query', required: true, schema: { type: 'string', format: 'date' } }]
const text = (maxLength: number) => ({ type: ['string', 'null'], maxLength })
const terminal = { terminal_code: text(10), name: text(80), pos_reg_no: text(30), is_active: { type: 'boolean' } }
export const operationsPaths = {
  '/api/staff/{userId}/active': { post: write('setStaffActive', { is_active: { type: 'boolean' } }, ['is_active'], [{ ...id, name: 'userId' }]) },
  '/api/members/find': { get: get('findMembers', [rid, { name: 'phone', in: 'query', required: true, schema: { type: 'string', pattern: '^(?:[0-9]{4}|0[0-9]{8,9})$' } }]) },
  '/api/members/{id}/export': { get: get('exportMember', [rid, id]) },
  '/api/members/{id}': { delete: get('deleteMember', [rid, id]) },
  '/api/feedback': { post: write('submitFeedback', { rating: { type: 'integer', minimum: 1, maximum: 5 }, client_ref: uuid }, ['rating', 'client_ref']) },
  '/api/feedback/report': { get: get('feedbackReport', dates) },
  '/api/promotions/coupon': { get: get('couponLookup', [rid, { name: 'code', in: 'query', required: true, schema: { type: 'string', maxLength: 40 } }]) },
  '/api/promotions/report': { get: get('promotionReport', dates) },
  '/api/stock/supplier-report': { get: get('supplierReceivingReport', dates) },
  '/api/stock/receipts/{id}/claim': { post: write('setReceiptClaim', { ingredient_id: uuid, status: { type: 'string', enum: ['pending', 'credited', 'accepted'] } }, ['ingredient_id', 'status'], [id]) },
  '/api/tax/documents/{id}': { patch: write('updateTaxDraft', { buyer_name: text(200), buyer_tax_id: text(13), buyer_branch_code: text(5), buyer_address: text(500), exempt_amount: { type: 'number', minimum: 0 }, amount: { type: 'number', minimum: 0 }, credit_note_reason: text(300) }, [], [id]) },
  '/api/tax/documents/{id}/void': { post: write('voidTaxDraft', { reason: text(300) }, ['reason'], [id]) },
  '/api/tax/settings': { get: get('getTaxSettings'), put: write('saveTaxSettings', { tax_id: text(13), company_name: text(200), branch_code: text(5), branch_name: text(100), registered_address: text(500), postcode: text(5) }, ['tax_id', 'company_name', 'registered_address']) },
  '/api/tax/terminals': { get: get('listTaxTerminals'), post: write('createTaxTerminal', terminal, ['terminal_code', 'name']) },
  '/api/tax/terminals/{id}': { patch: write('updateTaxTerminal', terminal, [], [id]), delete: get('deleteTaxTerminal', [rid, id]) },
}
