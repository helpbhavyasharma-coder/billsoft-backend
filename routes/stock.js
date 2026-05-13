const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const { authenticate, attachCompany } = require('../middleware/auth');

router.use(authenticate, attachCompany);

router.get('/summary', async (req, res) => {
  try {
    const [rows] = await query(
      `SELECT pr.id, pr.name, pr.category, pr.unit,
       COALESCE(SUM(CASE WHEN sm.movement_type = 'purchase_in' THEN sm.qty ELSE 0 END), 0) as purchased_qty,
       COALESCE((SELECT SUM(ii.qty) FROM invoice_items ii JOIN invoices i ON ii.invoice_id = i.id WHERE ii.product_id = pr.id AND i.company_id = ? AND i.status != 'cancelled'), 0) as sold_qty,
       COALESCE(SUM(CASE WHEN sm.movement_type = 'damage' THEN sm.qty ELSE 0 END), 0) as damaged_qty,
       COALESCE(SUM(CASE WHEN sm.movement_type = 'expiry' THEN sm.qty ELSE 0 END), 0) as expired_qty,
       COALESCE(SUM(CASE WHEN sm.movement_type = 'adjustment_in' THEN sm.qty WHEN sm.movement_type = 'adjustment_out' THEN -sm.qty ELSE 0 END), 0) as adjustment_qty
       FROM products pr
       LEFT JOIN stock_movements sm ON sm.product_id = pr.id AND sm.company_id = ?
       WHERE pr.company_id = ? AND pr.is_active = 1
       GROUP BY pr.id, pr.name, pr.category, pr.unit
       ORDER BY COALESCE(pr.category, ''), pr.name`,
      [req.companyId, req.companyId, req.companyId]
    );

    const stock = rows.map((row) => {
      const purchased = parseFloat(row.purchased_qty || 0);
      const sold = parseFloat(row.sold_qty || 0);
      const damaged = parseFloat(row.damaged_qty || 0);
      const expired = parseFloat(row.expired_qty || 0);
      const adjustment = parseFloat(row.adjustment_qty || 0);
      return { ...row, current_stock: purchased - sold - damaged - expired + adjustment };
    });

    res.json({ success: true, stock });
  } catch (err) {
    console.error('Stock summary error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

router.get('/movements/:productId', async (req, res) => {
  try {
    const [rows] = await query(
      `SELECT * FROM stock_movements
       WHERE company_id = ? AND product_id = ?
       ORDER BY movement_date DESC, id DESC`,
      [req.companyId, req.params.productId]
    );
    res.json({ success: true, movements: rows });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

router.post('/adjustment', async (req, res) => {
  try {
    const { product_id, movement_date, movement_type, qty, notes } = req.body;
    if (!product_id || !movement_date || !qty) {
      return res.status(400).json({ success: false, message: 'Product, date and quantity are required.' });
    }
    if (!['adjustment_in', 'adjustment_out', 'damage', 'expiry'].includes(movement_type)) {
      return res.status(400).json({ success: false, message: 'Invalid movement type.' });
    }

    await query(
      `INSERT INTO stock_movements (company_id, product_id, movement_date, movement_type, qty, reference_type, notes)
       VALUES (?,?,?,?,?,?,?)`,
      [req.companyId, product_id, movement_date, movement_type, qty, 'manual', notes || '']
    );

    res.status(201).json({ success: true, message: 'Stock updated.' });
  } catch (err) {
    console.error('Stock adjustment error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

module.exports = router;
