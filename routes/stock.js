const express = require('express');
const router = express.Router();
const { query, getConnection } = require('../config/db');
const { authenticate, attachCompany } = require('../middleware/auth');

router.use(authenticate, attachCompany);

async function syncStockMovements(companyId) {
  const conn = await getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `DELETE FROM stock_movements
       WHERE company_id = ? AND reference_type IN ('invoice','purchase','goods_return')`,
      [companyId]
    );

    const [invoiceRows] = await conn.query(
      `SELECT i.id, i.company_id, i.invoice_date, i.invoice_no, ii.product_id, ii.qty
       FROM invoice_items ii
       JOIN invoices i ON i.id = ii.invoice_id
       WHERE i.company_id = ? AND i.status != 'cancelled' AND ii.product_id IS NOT NULL AND ii.qty > 0`,
      [companyId]
    );
    for (const row of invoiceRows) {
      await conn.query(
        `INSERT INTO stock_movements (company_id, product_id, movement_date, movement_type, qty, reference_type, reference_id, notes)
         VALUES (?,?,?,?,?,?,?,?)`,
        [companyId, row.product_id, row.invoice_date, 'sale_out', row.qty, 'invoice', row.id, `Invoice sale ${row.invoice_no || ''}`.trim()]
      );
    }

    const [purchaseRows] = await conn.query(
      `SELECT pb.id, pb.company_id, pb.purchase_date, pb.bill_no, pi.product_id, pi.qty, pi.short_qty, pi.damaged_qty, pi.expired_qty, pi.accepted_qty
       FROM purchase_items pi
       JOIN purchase_bills pb ON pb.id = pi.purchase_id
       WHERE pb.company_id = ? AND COALESCE(pb.status, 'active') != 'cancelled' AND pi.product_id IS NOT NULL`,
      [companyId]
    );
    for (const row of purchaseRows) {
      const accepted = Math.max(
        parseFloat(row.accepted_qty || 0),
        parseFloat(row.qty || 0) - parseFloat(row.short_qty || 0) - parseFloat(row.damaged_qty || 0) - parseFloat(row.expired_qty || 0)
      );
      const damaged = parseFloat(row.damaged_qty || 0);
      const expired = parseFloat(row.expired_qty || 0);
      const billNote = row.bill_no ? ` ${row.bill_no}` : '';

      if (accepted > 0) {
        await conn.query(
          `INSERT INTO stock_movements (company_id, product_id, movement_date, movement_type, qty, reference_type, reference_id, notes)
           VALUES (?,?,?,?,?,?,?,?)`,
          [companyId, row.product_id, row.purchase_date, 'purchase_in', accepted, 'purchase', row.id, `Purchase${billNote}`]
        );
      }
      if (damaged > 0) {
        await conn.query(
          `INSERT INTO stock_movements (company_id, product_id, movement_date, movement_type, qty, reference_type, reference_id, notes)
           VALUES (?,?,?,?,?,?,?,?)`,
          [companyId, row.product_id, row.purchase_date, 'damage', damaged, 'purchase', row.id, `Damaged in purchase${billNote}`]
        );
      }
      if (expired > 0) {
        await conn.query(
          `INSERT INTO stock_movements (company_id, product_id, movement_date, movement_type, qty, reference_type, reference_id, notes)
           VALUES (?,?,?,?,?,?,?,?)`,
          [companyId, row.product_id, row.purchase_date, 'expiry', expired, 'purchase', row.id, `Expired in purchase${billNote}`]
        );
      }
    }

    const [returnRows] = await conn.query(
      `SELECT gr.id, gr.company_id, gr.return_date, gr.return_no, gri.product_id, gri.qty
       FROM goods_return_items gri
       JOIN goods_returns gr ON gr.id = gri.return_id
       WHERE gr.company_id = ? AND gri.product_id IS NOT NULL AND gri.qty > 0`,
      [companyId]
    ).catch(() => [[]]);
    for (const row of returnRows) {
      await conn.query(
        `INSERT INTO stock_movements (company_id, product_id, movement_date, movement_type, qty, reference_type, reference_id, notes)
         VALUES (?,?,?,?,?,?,?,?)`,
        [companyId, row.product_id, row.return_date, 'sale_return_in', row.qty, 'goods_return', row.id, `Goods return ${row.return_no || ''}`.trim()]
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

router.get('/summary', async (req, res) => {
  try {
    await syncStockMovements(req.companyId);
    const [rows] = await query(
      `SELECT pr.id, pr.name, pr.category, pr.unit,
       COALESCE(SUM(CASE WHEN sm.movement_type = 'purchase_in' THEN sm.qty ELSE 0 END), 0) as purchased_qty,
       COALESCE(SUM(CASE WHEN sm.movement_type = 'sale_out' THEN sm.qty ELSE 0 END), 0) as sold_qty,
       COALESCE(SUM(CASE WHEN sm.movement_type = 'sale_return_in' THEN sm.qty ELSE 0 END), 0) as returned_qty,
       COALESCE(SUM(CASE WHEN sm.movement_type = 'damage' THEN sm.qty ELSE 0 END), 0) as damaged_qty,
       COALESCE(SUM(CASE WHEN sm.movement_type = 'expiry' THEN sm.qty ELSE 0 END), 0) as expired_qty,
       COALESCE(SUM(CASE WHEN sm.movement_type = 'adjustment_in' THEN sm.qty WHEN sm.movement_type = 'adjustment_out' THEN -sm.qty ELSE 0 END), 0) as adjustment_qty
       FROM products pr
       LEFT JOIN stock_movements sm ON sm.product_id = pr.id AND sm.company_id = ?
       WHERE pr.company_id = ? AND pr.is_active = 1
       GROUP BY pr.id, pr.name, pr.category, pr.unit
       ORDER BY COALESCE(pr.category, ''), pr.name`,
      [req.companyId, req.companyId]
    );

    const stock = rows.map((row) => {
      const purchased = parseFloat(row.purchased_qty || 0);
      const sold = parseFloat(row.sold_qty || 0);
      const returned = parseFloat(row.returned_qty || 0);
      const damaged = parseFloat(row.damaged_qty || 0);
      const expired = parseFloat(row.expired_qty || 0);
      const adjustment = parseFloat(row.adjustment_qty || 0);
      return { ...row, current_stock: purchased - sold + returned - damaged - expired + adjustment };
    });

    res.json({ success: true, stock });
  } catch (err) {
    console.error('Stock summary error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

router.get('/movements/:productId', async (req, res) => {
  try {
    await syncStockMovements(req.companyId);
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
