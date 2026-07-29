const test = require('node:test');
const assert = require('node:assert/strict');
const { calculatePurchaseTotals, validateInvoicePayment } = require('../utils/accountingRules');

test('purchase totals use accepted quantity after short, damage, and expiry cuts', () => {
  const { normalizedItems, totals } = calculatePurchaseTotals([
    { qty: 10, short_qty: 1, damaged_qty: 2, expired_qty: 1, rate: 100, gst_rate: 5 },
  ]);

  assert.equal(normalizedItems[0].accepted_qty, 6);
  assert.equal(totals.subtotal, 600);
  assert.equal(totals.totalGst, 30);
  assert.equal(totals.grandTotal, 630);
});

test('purchase accepted quantity never goes below zero', () => {
  const { normalizedItems, totals } = calculatePurchaseTotals([
    { qty: 2, short_qty: 3, damaged_qty: 2, expired_qty: 1, rate: 100, gst_rate: 18 },
  ]);

  assert.equal(normalizedItems[0].accepted_qty, 0);
  assert.equal(totals.grandTotal, 0);
});

test('invoice payment rejects overpayment', () => {
  const result = validateInvoicePayment({ grand_total: 1000, amount_paid: 800, status: 'draft' }, 250);

  assert.equal(result.ok, false);
  assert.match(result.message, /Payment exceeds outstanding amount/);
});

test('invoice payment accepts exact outstanding amount', () => {
  const result = validateInvoicePayment({ grand_total: 1000, amount_paid: 800, status: 'draft' }, 200);

  assert.equal(result.ok, true);
  assert.equal(result.newAmountPaid, 1000);
});
