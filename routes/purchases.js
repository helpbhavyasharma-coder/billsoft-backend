const express = require('express');
const router = express.Router();
const { query, getConnection } = require('../config/db');
const { authenticate, attachCompany } = require('../middleware/auth');
const { calculatePurchaseTotals } = require('../utils/accountingRules');

router.use(authenticate, attachCompany);

function derivePayment(total, paid) {
  const amountPaid = Math.min(Math.max(parseFloat(paid || 0), 0), parseFloat(total || 0));
  let status = 'unpaid';
  if (amountPaid >= parseFloat(total || 0) && parseFloat(total || 0) > 0) status = 'paid';
  else if (amountPaid > 0) status = 'partial';
  return { amountPaid, status };
}

const insertPurchaseItemsAndStock = async (conn, companyId, purchaseId, purchaseDate, items) => {
  for (const item of items) {
    if (!item.product_id) continue;
    await conn.query(
      `INSERT INTO purchase_items (purchase_id, product_id, qty, short_qty, damaged_qty, expired_qty, accepted_qty, rate, rate_including_gst, gst_rate, taxable_amount, gst_amount, total_amount, expiry_date, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [purchaseId, item.product_id, item.qty, item.short_qty, item.damaged_qty, item.expired_qty, item.accepted_qty, item.rate, item.rate_including_gst, item.gst_rate, item.taxable_amount, item.gst_amount, item.total_amount, item.expiry_date || null, item.notes || '']
    );

    await conn.query(
      `INSERT INTO stock_movements (company_id, product_id, movement_date, movement_type, qty, reference_type, reference_id, notes)
       VALUES (?,?,?,?,?,?,?,?)`,
      [companyId, item.product_id, purchaseDate, 'purchase_in', item.accepted_qty, 'purchase', purchaseId, item.notes || '']
    );

    if (item.damaged_qty > 0) {
      await conn.query(
        `INSERT INTO stock_movements (company_id, product_id, movement_date, movement_type, qty, reference_type, reference_id, notes)
         VALUES (?,?,?,?,?,?,?,?)`,
        [companyId, item.product_id, purchaseDate, 'damage', item.damaged_qty, 'purchase', purchaseId, item.notes || '']
      );
    }

    if (item.expired_qty > 0) {
      await conn.query(
        `INSERT INTO stock_movements (company_id, product_id, movement_date, movement_type, qty, reference_type, reference_id, notes)
         VALUES (?,?,?,?,?,?,?,?)`,
        [companyId, item.product_id, purchaseDate, 'expiry', item.expired_qty, 'purchase', purchaseId, item.notes || '']
      );
    }
  }
};

router.get('/', async (req, res) => {
  try {
    const [rows] = await query(
      `SELECT pb.*, p.name as supplier_name,
       (pb.grand_total - COALESCE(pb.amount_paid, 0)) as payable
       FROM purchase_bills pb
       LEFT JOIN parties p ON pb.supplier_id = p.id
       WHERE pb.company_id = ? AND COALESCE(pb.status, 'active') != 'cancelled'
       ORDER BY pb.purchase_date DESC, pb.id DESC`,
      [req.companyId]
    );
    res.json({ success: true, purchases: rows });
  } catch (err) {
    console.error('Purchases list error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

router.get('/payables', async (req, res) => {
  try {
    const [rows] = await query(
      `SELECT p.id as supplier_id, p.name as supplier_name, p.mobile,
       COUNT(pb.id) as total_bills,
       COALESCE(SUM(pb.grand_total), 0) as total_amount,
       COALESCE(SUM(pb.amount_paid), 0) as total_paid,
       COALESCE(SUM(pb.grand_total - COALESCE(pb.amount_paid, 0)), 0) as payable
       FROM parties p
       JOIN purchase_bills pb ON pb.supplier_id = p.id AND pb.company_id = ? AND COALESCE(pb.status, 'active') != 'cancelled'
       WHERE p.company_id = ? AND p.is_active = 1
       GROUP BY p.id, p.name, p.mobile
       HAVING payable > 0
       ORDER BY payable DESC`,
      [req.companyId, req.companyId]
    );
    res.json({ success: true, payables: rows });
  } catch (err) {
    console.error('Purchase payables error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const [rows] = await query(
      `SELECT pb.*, p.name as supplier_name
       FROM purchase_bills pb
       LEFT JOIN parties p ON pb.supplier_id = p.id
       WHERE pb.id = ? AND pb.company_id = ? AND COALESCE(pb.status, 'active') != 'cancelled'`,
      [req.params.id, req.companyId]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Purchase bill not found.' });

    const [items] = await query(
      `SELECT pi.*, pr.name as product_name, pr.category, pr.unit
       FROM purchase_items pi
       LEFT JOIN products pr ON pi.product_id = pr.id
       WHERE pi.purchase_id = ?
       ORDER BY pi.id ASC`,
      [req.params.id]
    );

    res.json({ success: true, purchase: { ...rows[0], items } });
  } catch (err) {
    console.error('Purchase detail error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

router.post('/', async (req, res) => {
  const conn = await getConnection();
  try {
    await conn.beginTransaction();

    const { supplier_id, bill_no, purchase_date, payment_mode, notes, items } = req.body;
    if (!purchase_date) {
      await conn.rollback();
      return res.status(400).json({ success: false, message: 'Purchase date is required.' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      await conn.rollback();
      return res.status(400).json({ success: false, message: 'At least one item is required.' });
    }

    const { normalizedItems, totals } = calculatePurchaseTotals(items, req.body.round_off);
    const { amountPaid, status } = derivePayment(totals.grandTotal, req.body.amount_paid);

    const [result] = await conn.query(
      `INSERT INTO purchase_bills (company_id, supplier_id, bill_no, purchase_date, subtotal, total_gst, round_off, grand_total, amount_paid, payment_status, payment_mode, notes, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [req.companyId, supplier_id || null, bill_no || '', purchase_date, totals.subtotal, totals.totalGst, totals.roundOff, totals.grandTotal, amountPaid, status, payment_mode || 'cash', notes || '', 'active']
    );

    const purchaseId = result.insertId;
    await insertPurchaseItemsAndStock(conn, req.companyId, purchaseId, purchase_date, normalizedItems);

    await conn.commit();
    res.status(201).json({ success: true, message: 'Purchase bill created.', purchase_id: purchaseId });
  } catch (err) {
    await conn.rollback();
    console.error('Purchase create error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

router.put('/:id', async (req, res) => {
  const conn = await getConnection();
  try {
    await conn.beginTransaction();

    const [existing] = await conn.query(
      "SELECT id FROM purchase_bills WHERE id = ? AND company_id = ? AND COALESCE(status, 'active') != 'cancelled'",
      [req.params.id, req.companyId]
    );
    if (existing.length === 0) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: 'Purchase bill not found.' });
    }

    const { supplier_id, bill_no, purchase_date, payment_mode, notes, items } = req.body;
    if (!purchase_date) {
      await conn.rollback();
      return res.status(400).json({ success: false, message: 'Purchase date is required.' });
    }
    if (!Array.isArray(items) || items.length === 0 || items.some((item) => !item.product_id)) {
      await conn.rollback();
      return res.status(400).json({ success: false, message: 'Select product in all rows.' });
    }

    const { normalizedItems, totals } = calculatePurchaseTotals(items, req.body.round_off);
    const { amountPaid, status } = derivePayment(totals.grandTotal, req.body.amount_paid);
    await conn.query(
      `UPDATE purchase_bills SET supplier_id=?, bill_no=?, purchase_date=?, subtotal=?, total_gst=?, round_off=?, grand_total=?, amount_paid=?, payment_status=?, payment_mode=?, notes=?, updated_at=datetime('now')
       WHERE id=? AND company_id=?`,
      [supplier_id || null, bill_no || '', purchase_date, totals.subtotal, totals.totalGst, totals.roundOff, totals.grandTotal, amountPaid, status, payment_mode || 'cash', notes || '', req.params.id, req.companyId]
    );
    await conn.query('DELETE FROM purchase_items WHERE purchase_id = ?', [req.params.id]);
    await conn.query(
      "DELETE FROM stock_movements WHERE company_id = ? AND reference_type = 'purchase' AND reference_id = ?",
      [req.companyId, req.params.id]
    );
    await insertPurchaseItemsAndStock(conn, req.companyId, req.params.id, purchase_date, normalizedItems);

    await conn.commit();
    res.json({ success: true, message: 'Purchase bill updated.', purchase_id: Number(req.params.id) });
  } catch (err) {
    await conn.rollback();
    console.error('Purchase update error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

router.delete('/:id', async (req, res) => {
  const conn = await getConnection();
  try {
    await conn.beginTransaction();

    const [existing] = await conn.query(
      "SELECT id FROM purchase_bills WHERE id = ? AND company_id = ? AND COALESCE(status, 'active') != 'cancelled'",
      [req.params.id, req.companyId]
    );
    if (existing.length === 0) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: 'Purchase bill not found.' });
    }

    await conn.query(
      "DELETE FROM stock_movements WHERE company_id = ? AND reference_type = 'purchase' AND reference_id = ?",
      [req.companyId, req.params.id]
    );
    await conn.query(
      "DELETE FROM ledger_entries WHERE company_id = ? AND reference_type = 'purchase_payment' AND reference_id = ?",
      [req.companyId, req.params.id]
    );
    await conn.query(
      "UPDATE purchase_bills SET status = 'cancelled', payment_status = 'unpaid', amount_paid = 0, updated_at = datetime('now') WHERE id = ? AND company_id = ?",
      [req.params.id, req.companyId]
    );

    await conn.commit();
    res.json({ success: true, message: 'Purchase bill cancelled.' });
  } catch (err) {
    await conn.rollback();
    console.error('Purchase delete error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

module.exports = router;
