const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const { authenticate, attachCompany } = require('../middleware/auth');

router.use(authenticate, attachCompany);

router.get('/accounts', async (req, res) => {
  try {
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
    const [rows] = await query(
      `SELECT la.*,
       COALESCE(SUM(CASE WHEN le.entry_type = 'credit' THEN le.amount ELSE -le.amount END), 0) as balance
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
