const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const { authenticate, attachCompany } = require('../middleware/auth');

router.use(authenticate, attachCompany);

// GET /api/products
router.get('/', async (req, res) => {
  try {
    const [rows] = await query(
      'SELECT * FROM products WHERE company_id = ? AND is_active = 1 ORDER BY name ASC',
      [req.companyId]
    );
    res.json({ success: true, products: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// GET /api/products/:id
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await query(
      'SELECT * FROM products WHERE id = ? AND company_id = ?',
      [req.params.id, req.companyId]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Product not found.' });
    res.json({ success: true, product: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// POST /api/products
router.post('/', async (req, res) => {
  try {
    const { name, hsn_code, unit, default_rate, gst_rate, category } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Product name is required.' });

    const [result] = await query(
      'INSERT INTO products (company_id, name, hsn_code, unit, default_rate, gst_rate, category) VALUES (?,?,?,?,?,?,?)',
      [req.companyId, name, hsn_code || '', unit || 'Pcs', default_rate || 0, gst_rate || 5, category || '']
    );

    const [created] = await query('SELECT * FROM products WHERE id = ?', [result.insertId]);
    res.status(201).json({ success: true, message: 'Product created.', product: created[0] });
  } catch (err) {
    console.error('Product create error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// PUT /api/products/:id
router.put('/:id', async (req, res) => {
  try {
    const { name, hsn_code, unit, default_rate, gst_rate, category } = req.body;
    const [existing] = await query(
      'SELECT id FROM products WHERE id = ? AND company_id = ?',
      [req.params.id, req.companyId]
    );
    if (existing.length === 0) return res.status(404).json({ success: false, message: 'Product not found.' });

    await query(
      'UPDATE products SET name=?, hsn_code=?, unit=?, default_rate=?, gst_rate=?, category=?, updated_at=datetime(\'now\') WHERE id=?',
      [name, hsn_code || '', unit || 'Pcs', default_rate || 0, gst_rate || 5, category || '', req.params.id]
    );

    const [updated] = await query('SELECT * FROM products WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Product updated.', product: updated[0] });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// DELETE /api/products/:id
router.delete('/:id', async (req, res) => {
  try {
    const [existing] = await query(
      'SELECT id FROM products WHERE id = ? AND company_id = ?',
      [req.params.id, req.companyId]
    );
    if (existing.length === 0) return res.status(404).json({ success: false, message: 'Product not found.' });

    await query('UPDATE products SET is_active = 0 WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Product deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// POST /api/products/bulk/import
router.post('/bulk/import', async (req, res) => {
  try {
    const { products } = req.body;
    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ success: false, message: 'Products array required.' });
    }

    for (const p of products) {
      await query(
        'INSERT INTO products (company_id, name, hsn_code, unit, default_rate, gst_rate, category) VALUES (?,?,?,?,?,?,?)',
        [req.companyId, p.name, p.hsn_code || '0910', p.unit || 'Pcs', p.default_rate || 0, p.gst_rate || 5, p.category || '']
      );
    }

    res.json({ success: true, message: `${products.length} products imported.` });
  } catch (err) {
    console.error('Bulk import error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

module.exports = router;
