const express = require('express');
const router = express.Router();
const { query, getConnection } = require('../config/db');
const { authenticate, attachCompany } = require('../middleware/auth');
const { validateInvoicePayment } = require('../utils/accountingRules');

router.use(authenticate, attachCompany);

function paymentLedgerConfig(mode = 'cash') {
  const normalized = String(mode || 'cash').toLowerCase();
  if (normalized === 'bank' || normalized === 'bank_transfer') return { type: 'bank', name: 'Bank Ledger', label: 'Bank' };
  if (normalized === 'upi') return { type: 'upi', name: 'UPI Ledger', label: 'UPI' };
  if (normalized === 'cheque') return { type: 'bank', name: 'Cheque Ledger', label: 'Cheque' };
  if (normalized === 'other') return { type: 'other', name: 'Other Receipts Ledger', label: 'Other' };
  return { type: 'cash', name: 'Cash Ledger', label: 'Cash' };
}

async function paymentLedgerAccountId(conn, companyId, mode) {
  const config = paymentLedgerConfig(mode);
  const [accounts] = await conn.query(
    `SELECT id FROM ledger_accounts
     WHERE company_id = ? AND is_active = 1 AND account_type = ? AND name = ?
     ORDER BY id ASC LIMIT 1`,
    [companyId, config.type, config.name]
  );
  if (accounts.length) return accounts[0].id;

  const [result] = await conn.query(
    `INSERT INTO ledger_accounts (company_id, name, account_type, opening_balance)
     VALUES (?,?,?,0)`,
    [companyId, config.name, config.type]
  );
  return result.insertId;
}

async function postCashLedgerForPayment(conn, companyId, paymentId, payment, invoice) {
  await conn.query(
    `DELETE FROM ledger_entries
     WHERE company_id = ? AND reference_type = 'payment' AND reference_id = ?`,
    [companyId, paymentId]
  );

  const [parties] = await conn.query(
    'SELECT name FROM parties WHERE id = ? AND company_id = ?',
    [payment.party_id, companyId]
  );
  const accountId = await paymentLedgerAccountId(conn, companyId, payment.payment_mode);
  const modeLabel = paymentLedgerConfig(payment.payment_mode).label;
  const partyName = parties[0]?.name || 'Party';
  const invoiceNo = invoice?.invoice_no || '';
  const description = invoiceNo
    ? `${modeLabel} received from ${partyName} against invoice ${invoiceNo}`
    : `${modeLabel} received from ${partyName} for outstanding`;

  await conn.query(
    `INSERT INTO ledger_entries
     (company_id, account_id, entry_date, entry_type, amount, description, reference_no, reference_type, reference_id)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      companyId,
      accountId,
      payment.payment_date,
      'credit',
      payment.amount,
      description,
      payment.reference_no || invoiceNo,
      'payment',
      paymentId,
    ]
  );
}

// POST /api/payments - Record a payment
router.post('/', async (req, res) => {
  const conn = await getConnection();
  try {
    await conn.beginTransaction();

    const { invoice_id, party_id, payment_type, amount, payment_date, payment_mode, reference_no, notes } = req.body;
    const type = payment_type || (invoice_id ? 'invoice' : 'general');
    const paymentAmount = parseFloat(amount || 0);
    if (!paymentAmount || paymentAmount <= 0 || !payment_date) {
      await conn.rollback();
      return res.status(400).json({ success: false, message: 'Positive amount and date required.' });
    }

    let invoice = null;
    let finalPartyId = party_id || null;

    if (type === 'invoice') {
      if (!invoice_id) {
        await conn.rollback();
        return res.status(400).json({ success: false, message: 'Invoice is required.' });
      }

      const [invoices] = await conn.query(
        `SELECT i.*, COALESCE((SELECT SUM(amount) FROM goods_returns WHERE invoice_id = i.id), 0) as goods_return_total
         FROM invoices i WHERE i.id = ? AND i.company_id = ?`,
        [invoice_id, req.companyId]
      );
      if (invoices.length === 0) {
        await conn.rollback();
        return res.status(404).json({ success: false, message: 'Invoice not found.' });
      }

      invoice = invoices[0];
      finalPartyId = invoice.party_id;
    } else {
      if (!finalPartyId) {
        await conn.rollback();
        return res.status(400).json({ success: false, message: 'Party is required.' });
      }

      const [parties] = await conn.query(
        'SELECT id FROM parties WHERE id = ? AND company_id = ? AND is_active = 1',
        [finalPartyId, req.companyId]
      );
      if (parties.length === 0) {
        await conn.rollback();
        return res.status(404).json({ success: false, message: 'Party not found.' });
      }
    }

    let newAmountPaid = null;
    let paymentStatus = null;
    if (invoice) {
      const paymentValidation = validateInvoicePayment(invoice, paymentAmount);
      if (!paymentValidation.ok) {
        await conn.rollback();
        return res.status(400).json({ success: false, message: paymentValidation.message });
      }
      const grandTotal = parseFloat(invoice.grand_total);
      newAmountPaid = paymentValidation.newAmountPaid;
      paymentStatus = 'partial';
      if (newAmountPaid >= grandTotal) paymentStatus = 'paid';
      else if (newAmountPaid <= 0) paymentStatus = 'unpaid';
    }

    const payment = {
      invoice_id: invoice ? invoice_id : null,
      party_id: finalPartyId,
      amount: paymentAmount,
      payment_date,
      payment_type: type,
      payment_mode: payment_mode || 'cash',
      reference_no: reference_no || '',
      notes: notes || '',
    };

    const [result] = await conn.query(
      `INSERT INTO payments (company_id, invoice_id, party_id, amount, payment_date, payment_type, payment_mode, reference_no, notes)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [req.companyId, payment.invoice_id, payment.party_id, payment.amount, payment.payment_date, payment.payment_type,
       payment.payment_mode, payment.reference_no, payment.notes]
    );

    await postCashLedgerForPayment(conn, req.companyId, result.insertId, payment, invoice);

    if (invoice) {
      await conn.query(
        `UPDATE invoices SET amount_paid = ?, payment_status = ?, updated_at = datetime('now') WHERE id = ?`,
        [newAmountPaid, paymentStatus, invoice_id]
      );
    }

    await conn.commit();

    const [updated] = invoice ? await query('SELECT * FROM invoices WHERE id = ?', [invoice_id]) : [[]];
    res.status(201).json({
      success: true,
      message: 'Payment recorded.',
      payment_id: result.insertId,
      invoice: updated[0] || null,
    });
  } catch (err) {
    await conn.rollback();
    console.error('Payment error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  } finally {
    if (conn.release) conn.release();
  }
});

// GET /api/payments/party/:partyId - All payments for a party
router.get('/party/:partyId', async (req, res) => {
  try {
    const [payments] = await query(
      `SELECT p.*, i.invoice_no FROM payments p
       LEFT JOIN invoices i ON p.invoice_id = i.id
       WHERE p.party_id = ? AND p.company_id = ?
       ORDER BY p.payment_date DESC, p.id DESC`,
      [req.params.partyId, req.companyId]
    );
    res.json({ success: true, payments });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// GET /api/payments/invoice/:id - Payment history for an invoice
router.get('/invoice/:id', async (req, res) => {
  try {
    const [payments] = await query(
      `SELECT p.* FROM payments p
       WHERE p.invoice_id = ? AND p.company_id = ?
       ORDER BY p.payment_date DESC`,
      [req.params.id, req.companyId]
    );
    res.json({ success: true, payments });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// DELETE /api/payments/:id - Delete a payment entry
router.delete('/:id', async (req, res) => {
  const conn = await getConnection();
  try {
    await conn.beginTransaction();

    const [payments] = await conn.query(
      'SELECT * FROM payments WHERE id = ? AND company_id = ?',
      [req.params.id, req.companyId]
    );
    if (payments.length === 0) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: 'Payment not found.' });
    }

    const payment = payments[0];
    await conn.query(
      `DELETE FROM ledger_entries
       WHERE company_id = ? AND reference_type = 'payment' AND reference_id = ?`,
      [req.companyId, req.params.id]
    );
    await conn.query('DELETE FROM payments WHERE id = ?', [req.params.id]);

    if (payment.invoice_id) {
      const [remaining] = await conn.query(
        'SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE invoice_id = ?',
        [payment.invoice_id]
      );
      const newPaid = parseFloat(remaining[0].total);
      const [inv] = await conn.query('SELECT grand_total FROM invoices WHERE id = ?', [payment.invoice_id]);
      const grandTotal = parseFloat(inv[0].grand_total);

      let status = 'unpaid';
      if (newPaid >= grandTotal) status = 'paid';
      else if (newPaid > 0) status = 'partial';

      await conn.query(
        `UPDATE invoices SET amount_paid = ?, payment_status = ? WHERE id = ?`,
        [newPaid, status, payment.invoice_id]
      );
    }

    await conn.commit();
    res.json({ success: true, message: 'Payment deleted.' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, message: 'Server error.' });
  } finally {
    if (conn.release) conn.release();
  }
});

// GET /api/payments/outstanding - Outstanding report party-wise
router.get('/outstanding', async (req, res) => {
  try {
    const [rows] = await query(
      `SELECT p.id as party_id, p.name as party_name, p.mobile,
       COALESCE(p.opening_balance, 0) as opening_balance,
       COUNT(i.id) as total_invoices,
       COALESCE(SUM(i.grand_total), 0) as total_amount,
       COALESCE(SUM(i.amount_paid), 0) + COALESCE(gp.general_paid, 0) as total_paid,
       COALESCE(SUM(i.grand_total - i.amount_paid), 0) as invoice_outstanding,
       COALESCE(gp.general_paid, 0) as general_paid,
       COALESCE(gr.goods_return_total, 0) as goods_return_total,
       COALESCE(p.opening_balance, 0) + COALESCE(SUM(i.grand_total - i.amount_paid), 0) - COALESCE(gp.general_paid, 0) - COALESCE(gr.goods_return_total, 0) as outstanding
       FROM parties p
       LEFT JOIN invoices i ON i.party_id = p.id AND i.company_id = ? AND i.status != 'cancelled'
       LEFT JOIN (
         SELECT party_id, SUM(amount) as general_paid
         FROM payments
         WHERE company_id = ? AND invoice_id IS NULL
         GROUP BY party_id
       ) gp ON gp.party_id = p.id
       LEFT JOIN (
         SELECT party_id, SUM(amount) as goods_return_total
         FROM goods_returns
         WHERE company_id = ?
         GROUP BY party_id
       ) gr ON gr.party_id = p.id
       WHERE p.company_id = ? AND p.is_active = 1
       GROUP BY p.id, p.name, p.mobile, p.opening_balance, gp.general_paid, gr.goods_return_total
       HAVING COALESCE(p.opening_balance, 0) + COALESCE(SUM(i.grand_total - i.amount_paid), 0) - COALESCE(gp.general_paid, 0) - COALESCE(gr.goods_return_total, 0) > 0
       ORDER BY outstanding DESC`,
      [req.companyId, req.companyId, req.companyId, req.companyId]
    );
    res.json({ success: true, outstanding: rows });
  } catch (err) {
    console.error('Outstanding error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

module.exports = router;
