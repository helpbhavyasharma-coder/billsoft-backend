const express = require('express');
const router = express.Router();
const { query, getConnection } = require('../config/db');
const { authenticate, attachCompany } = require('../middleware/auth');

router.use(authenticate, attachCompany);

// POST /api/payments - Record a payment
router.post('/', async (req, res) => {
  const conn = await getConnection();
  try {
    await conn.beginTransaction();

    const { invoice_id, party_id, payment_type, amount, payment_date, payment_mode, reference_no, notes } = req.body;
    const type = payment_type || (invoice_id ? 'invoice' : 'general');
    if (!amount || !payment_date) {
      await conn.rollback();
      return res.status(400).json({ success: false, message: 'Amount and date required.' });
    }

    let invoice = null;
    let finalPartyId = party_id || null;

    if (type === 'invoice') {
      if (!invoice_id) {
        await conn.rollback();
        return res.status(400).json({ success: false, message: 'Invoice is required.' });
      }

      const [invoices] = await conn.query(
        'SELECT * FROM invoices WHERE id = ? AND company_id = ?',
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
      newAmountPaid = parseFloat(invoice.amount_paid || 0) + parseFloat(amount);
      const grandTotal = parseFloat(invoice.grand_total);
      paymentStatus = 'partial';
      if (newAmountPaid >= grandTotal) paymentStatus = 'paid';
      else if (newAmountPaid <= 0) paymentStatus = 'unpaid';
    }

    const [result] = await conn.query(
      `INSERT INTO payments (company_id, invoice_id, party_id, amount, payment_date, payment_type, payment_mode, reference_no, notes)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [req.companyId, invoice ? invoice_id : null, finalPartyId, amount, payment_date, type,
       payment_mode || 'cash', reference_no || '', notes || '']
    );

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
       COALESCE(p.opening_balance, 0) + COALESCE(SUM(i.grand_total - i.amount_paid), 0) - COALESCE(gp.general_paid, 0) as outstanding
       FROM parties p
       LEFT JOIN invoices i ON i.party_id = p.id AND i.company_id = ? AND i.status != 'cancelled'
         AND i.payment_status IN ('unpaid','partial')
       LEFT JOIN (
         SELECT party_id, SUM(amount) as general_paid
         FROM payments
         WHERE company_id = ? AND invoice_id IS NULL
         GROUP BY party_id
       ) gp ON gp.party_id = p.id
       WHERE p.company_id = ? AND p.is_active = 1
       GROUP BY p.id, p.name, p.mobile, p.opening_balance, gp.general_paid
       HAVING COALESCE(p.opening_balance, 0) + COALESCE(SUM(i.grand_total - i.amount_paid), 0) - COALESCE(gp.general_paid, 0) > 0
       ORDER BY outstanding DESC`,
      [req.companyId, req.companyId, req.companyId]
    );
    res.json({ success: true, outstanding: rows });
  } catch (err) {
    console.error('Outstanding error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

module.exports = router;
