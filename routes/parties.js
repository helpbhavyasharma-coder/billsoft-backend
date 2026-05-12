const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const { authenticate, attachCompany } = require('../middleware/auth');

router.use(authenticate, attachCompany);

// GET /api/parties
router.get('/', async (req, res) => {
  try {
    const { search } = req.query;
    let sql = 'SELECT * FROM parties WHERE company_id = ? AND is_active = 1';
    const params = [req.companyId];

    if (search) {
      if (process.env.DATABASE_URL) {
        sql += ' AND (name ILIKE ? OR mobile ILIKE ? OR gst_no ILIKE ?)';
      } else {
        sql += ' AND (name LIKE ? OR mobile LIKE ? OR gst_no LIKE ?)';
      }
      const s = `%${search}%`;
      params.push(s, s, s);
    }
    sql += ' ORDER BY name ASC';

    const [rows] = await query(sql, params);
    res.json({ success: true, parties: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// GET /api/parties/:id
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await query(
      'SELECT * FROM parties WHERE id = ? AND company_id = ?',
      [req.params.id, req.companyId]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Party not found.' });
    res.json({ success: true, party: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// POST /api/parties
router.post('/', async (req, res) => {
  try {
    const { name, address, city, state, mobile, email, gst_no, party_type, opening_balance } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Party name is required.' });

    const [result] = await query(
      'INSERT INTO parties (company_id, name, address, city, state, mobile, email, gst_no, party_type, opening_balance) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [req.companyId, name, address || '', city || '', state || '', mobile || '', email || '', gst_no || 'NA', party_type || 'customer', opening_balance || 0]
    );

    const [created] = await query('SELECT * FROM parties WHERE id = ?', [result.insertId]);
    res.status(201).json({ success: true, message: 'Party created.', party: created[0] });
  } catch (err) {
    console.error('Party create error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// PUT /api/parties/:id
router.put('/:id', async (req, res) => {
  try {
    const { name, address, city, state, mobile, email, gst_no, party_type } = req.body;
    const [existing] = await query(
      'SELECT id FROM parties WHERE id = ? AND company_id = ?',
      [req.params.id, req.companyId]
    );
    if (existing.length === 0) return res.status(404).json({ success: false, message: 'Party not found.' });

    await query(
      'UPDATE parties SET name=?, address=?, city=?, state=?, mobile=?, email=?, gst_no=?, party_type=?, updated_at=datetime(\'now\') WHERE id=?',
      [name, address || '', city || '', state || '', mobile || '', email || '', gst_no || 'NA', party_type || 'customer', req.params.id]
    );

    const [updated] = await query('SELECT * FROM parties WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Party updated.', party: updated[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// DELETE /api/parties/:id
router.delete('/:id', async (req, res) => {
  try {
    const [existing] = await query(
      'SELECT id FROM parties WHERE id = ? AND company_id = ?',
      [req.params.id, req.companyId]
    );
    if (existing.length === 0) return res.status(404).json({ success: false, message: 'Party not found.' });

    await query('UPDATE parties SET is_active = 0 WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Party deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

module.exports = router;
