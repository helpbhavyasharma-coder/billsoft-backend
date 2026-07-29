const num = (value) => parseFloat(value || 0);

function calculatePurchaseTotals(items, roundOff = 0) {
  let subtotal = 0;
  let totalGst = 0;
  let grandTotal = 0;

  const normalizedItems = (items || []).map((item) => {
    const qty = num(item.qty);
    const shortQty = num(item.short_qty);
    const damagedQty = num(item.damaged_qty);
    const expiredQty = num(item.expired_qty);
    const acceptedQty = Math.max(qty - shortQty - damagedQty - expiredQty, 0);
    const gstRate = num(item.gst_rate);
    const inclusiveRate = num(item.rate_including_gst);
    const rate = inclusiveRate > 0 ? inclusiveRate / (1 + gstRate / 100) : num(item.rate);
    const taxable = acceptedQty * rate;
    const gstAmount = taxable * gstRate / 100;
    const total = taxable + gstAmount;

    subtotal += taxable;
    totalGst += gstAmount;
    grandTotal += total;

    return {
      ...item,
      qty,
      short_qty: shortQty,
      damaged_qty: damagedQty,
      expired_qty: expiredQty,
      accepted_qty: acceptedQty,
      rate,
      rate_including_gst: inclusiveRate > 0 ? inclusiveRate : rate * (1 + gstRate / 100),
      gst_rate: gstRate,
      taxable_amount: taxable,
      gst_amount: gstAmount,
      total_amount: total,
    };
  });

  const roundedGrandTotal = grandTotal + num(roundOff);
  return { normalizedItems, totals: { subtotal, totalGst, roundOff: num(roundOff), grandTotal: roundedGrandTotal } };
}

function validateInvoicePayment(invoice, amount) {
  const paymentAmount = num(amount);
  if (paymentAmount <= 0) return { ok: false, message: 'Positive amount and date required.' };
  if (invoice?.status === 'cancelled') return { ok: false, message: 'Cannot record payment against a cancelled invoice.' };

  const grandTotal = num(invoice?.grand_total);
  const currentPaid = num(invoice?.amount_paid);
  const returned = num(invoice?.goods_return_total);
  const outstanding = Math.max(grandTotal - currentPaid - returned, 0);
  if (paymentAmount > outstanding) {
    return {
      ok: false,
      message: `Payment exceeds outstanding amount. Pending amount is ${outstanding.toFixed(2)}.`,
    };
  }
  return { ok: true, outstanding, newAmountPaid: currentPaid + paymentAmount };
}

module.exports = { calculatePurchaseTotals, validateInvoicePayment };
