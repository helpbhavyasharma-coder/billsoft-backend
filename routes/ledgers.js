const express = require('express');
const router = express.Router();
const { query, getConnection } = require('../config/db');
const { authenticate, attachCompany } = require('../middleware/auth');

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

async function syncCashLedgerPayments(companyId) {
  const conn = await getConnection();
  try {
    await conn.beginTransaction();
    const [payments] = await conn.query(
      `SELECT p.*, i.invoice_no, pa.name as party_name
       FROM payments p
       LEFT JOIN invoices i ON i.id = p.invoice_id AND i.company_id = p.company_id
       LEFT JOIN parties pa ON pa.id = p.party_id AND pa.company_id = p.company_id
       WHERE p.company_id = ?`,
      [companyId]
    );

    for (const payment of payments) {
      await conn.query(
        `DELETE FROM ledger_entries
         WHERE company_id = ? AND reference_type = 'payment' AND reference_id = ?`,
        [companyId, payment.id]
      );

      const accountId = await paymentLedgerAccountId(conn, companyId, payment.payment_mode);
      const modeLabel = paymentLedgerConfig(payment.payment_mode).label;
      const invoiceNo = payment.invoice_no || '';
      const partyName = payment.party_name || 'Party';
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
          payment.id,
        ]
      );
    }

    const [purchases] = await conn.query(
      `SELECT pb.*, pa.name as supplier_name
       FROM purchase_bills pb
       LEFT JOIN parties pa ON pa.id = pb.supplier_id AND pa.company_id = pb.company_id
       WHERE pb.company_id = ? AND COALESCE(pb.status, 'active') != 'cancelled'`,
      [companyId]
    );
    for (const purchase of purchases) {
      await conn.query(
        `DELETE FROM ledger_entries
         WHERE company_id = ? AND reference_type = 'purchase_payment' AND reference_id = ?`,
        [companyId, purchase.id]
      );
      const paid = parseFloat(purchase.amount_paid || 0);
      if (!paid) continue;
      const accountId = await paymentLedgerAccountId(conn, companyId, purchase.payment_mode);
      const modeLabel = paymentLedgerConfig(purchase.payment_mode).label;
      const supplierName = purchase.supplier_name || 'Supplier';
      await conn.query(
        `INSERT INTO ledger_entries
         (company_id, account_id, entry_date, entry_type, amount, description, reference_no, reference_type, reference_id)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          companyId,
          accountId,
          purchase.purchase_date,
          'debit',
          paid,
          `${modeLabel} paid to ${supplierName} against purchase ${purchase.bill_no || purchase.id}`,
          purchase.bill_no || '',
          'purchase_payment',
          purchase.id,
        ]
      );
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    if (conn.release) conn.release();
  }
}

router.get('/accounts', async (req, res) => {
  try {
    await syncCashLedgerPayments(req.companyId);
    const [accounts] = await query(
      'SELECT * FROM ledger_accounts WHERE company_id = ? AND is_active = 1 ORDER BY account_type ASC, name ASC',
      [req.companyId]
    );
    res.json({ success: true, accounts });
  } catch (err) {
    console.error('Ledger accounts error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

router.post('/accounts', async (req, res) => {
  try {
    const { name, account_type, account_no, ifsc, branch, opening_balance } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Account name is required.' });

    const type = account_type || 'bank';
    const [result] = await query(
      `INSERT INTO ledger_accounts (company_id, name, account_type, account_no, ifsc, branch, opening_balance)
       VALUES (?,?,?,?,?,?,?)`,
      [req.companyId, name, type, account_no || '', ifsc || '', branch || '', opening_balance || 0]
    );

    if (parseFloat(opening_balance || 0) !== 0) {
      await query(
        `INSERT INTO ledger_entries (company_id, account_id, entry_date, entry_type, amount, description, reference_type)
         VALUES (?,?,?,?,?,?,?)`,
        [req.companyId, result.insertId, new Date().toISOString().slice(0, 10), parseFloat(opening_balance) >= 0 ? 'credit' : 'debit', Math.abs(parseFloat(opening_balance)), 'Opening Balance', 'opening']
      );
    }

    res.status(201).json({ success: true, message: 'Account created.', account_id: result.insertId });
  } catch (err) {
    console.error('Ledger account create error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

router.put('/accounts/:id', async (req, res) => {
  try {
    const { name, account_type, account_no, ifsc, branch, opening_balance } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Account name is required.' });

    const [existing] = await query(
      'SELECT id FROM ledger_accounts WHERE id = ? AND company_id = ? AND is_active = 1',
      [req.params.id, req.companyId]
    );
    if (existing.length === 0) return res.status(404).json({ success: false, message: 'Ledger account not found.' });

    await query(
      `UPDATE ledger_accounts
       SET name=?, account_type=?, account_no=?, ifsc=?, branch=?, opening_balance=?
       WHERE id=? AND company_id=?`,
      [name, account_type || 'bank', account_no || '', ifsc || '', branch || '', opening_balance || 0, req.params.id, req.companyId]
    );

    res.json({ success: true, message: 'Account updated.' });
  } catch (err) {
    console.error('Ledger account update error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

router.delete('/accounts/:id', async (req, res) => {
  try {
    const [existing] = await query(
      'SELECT id FROM ledger_accounts WHERE id = ? AND company_id = ? AND is_active = 1',
      [req.params.id, req.companyId]
    );
    if (existing.length === 0) return res.status(404).json({ success: false, message: 'Ledger account not found.' });

    await query('UPDATE ledger_accounts SET is_active = 0 WHERE id = ? AND company_id = ?', [req.params.id, req.companyId]);
    res.json({ success: true, message: 'Account deleted.' });
  } catch (err) {
    console.error('Ledger account delete error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

router.get('/accounts/:id/entries', async (req, res) => {
  try {
    await syncCashLedgerPayments(req.companyId);
    const [entries] = await query(
      `SELECT * FROM ledger_entries
       WHERE company_id = ? AND account_id = ?
       ORDER BY entry_date DESC, id DESC`,
      [req.companyId, req.params.id]
    );
    res.json({ success: true, entries });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

router.post('/entries', async (req, res) => {
  try {
    const { account_id, entry_date, entry_type, amount, description, reference_no } = req.body;
    if (!account_id || !entry_date || !amount) {
      return res.status(400).json({ success: false, message: 'Account, date and amount are required.' });
    }
    if (!['debit', 'credit'].includes(entry_type)) {
      return res.status(400).json({ success: false, message: 'Invalid entry type.' });
    }

    await query(
      `INSERT INTO ledger_entries (company_id, account_id, entry_date, entry_type, amount, description, reference_no, reference_type)
       VALUES (?,?,?,?,?,?,?,?)`,
      [req.companyId, account_id, entry_date, entry_type, amount, description || '', reference_no || '', 'manual']
    );

    res.status(201).json({ success: true, message: 'Ledger entry added.' });
  } catch (err) {
    console.error('Ledger entry error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

router.get('/summary', async (req, res) => {
  try {
    await syncCashLedgerPayments(req.companyId);
    const [rows] = await query(
      `SELECT la.*,
       la.opening_balance + COALESCE(SUM(CASE WHEN le.entry_type = 'credit' THEN le.amount ELSE -le.amount END), 0) as balance
       FROM ledger_accounts la
       LEFT JOIN ledger_entries le ON le.account_id = la.id AND le.company_id = ?
       WHERE la.company_id = ? AND la.is_active = 1
       GROUP BY la.id, la.company_id, la.name, la.account_type, la.account_no, la.ifsc, la.branch, la.opening_balance, la.is_active, la.created_at
       ORDER BY la.account_type ASC, la.name ASC`,
      [req.companyId, req.companyId]
    );
    res.json({ success: true, summary: rows });
  } catch (err) {
    console.error('Ledger summary error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

module.exports = router;
