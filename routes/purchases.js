const express = require('express');
const router = express.Router();
const { query, getConnection } = require('../config/db');
const { authenticate, attachCompany } = require('../middleware/auth');

router.use(authenticate, attachCompany);

const num = (value) => parseFloat(value || 0);

router.get('/', async (req, res) => {
  try {
    const [rows] = await query(
      `SELECT pb.*, p.name as supplier_name
       FROM purchase_bills pb
       LEFT JOIN parties p ON pb.supplier_id = p.id
       WHERE pb.company_id = ?
       ORDER BY pb.purchase_date DESC, pb.id DESC`,
      [req.companyId]
    );
    res.json({ success: true, purchases: rows });
  } catch (err) {
    console.error('Purchases list error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const [rows] = await query(
      `SELECT pb.*, p.name as supplier_name
       FROM purchase_bills pb
       LEFT JOIN parties p ON pb.supplier_id = p.id
       WHERE pb.id = ? AND pb.company_id = ?`,
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

    const { supplier_id, bill_no, purchase_date, payment_status, payment_mode, notes, items } = req.body;
    if (!purchase_date) {
      await conn.rollback();
      return res.status(400).json({ success: false, message: 'Purchase date is required.' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      await conn.rollback();
      return res.status(400).json({ success: false, message: 'At least one item is required.' });
    }

    let subtotal = 0;
    let totalGst = 0;
    let grandTotal = 0;

    const normalizedItems = items.map((item) => {
      const qty = num(item.qty);
      const shortQty = num(item.short_qty);
      const damagedQty = num(item.damaged_qty);
      const expiredQty = num(item.expired_qty);
      const acceptedQty = Math.max(qty - shortQty - damagedQty - expiredQty, 0);
      const rate = num(item.rate);
      const gstRate = num(item.gst_rate);
      const taxable = acceptedQty * rate;
      const gstAmount = taxable * gstRate / 100;
      const total = taxable + gstAmount;
      subtotal += taxable;
      totalGst += gstAmount;
      grandTotal += total;
      return { ...item, qty, short_qty: shortQty, damaged_qty: damagedQty, expired_qty: expiredQty, accepted_qty: acceptedQty, rate, gst_rate: gstRate, taxable_amount: taxable, gst_amount: gstAmount, total_amount: total };
    });

    const [result] = await conn.query(
      `INSERT INTO purchase_bills (company_id, supplier_id, bill_no, purchase_date, subtotal, total_gst, grand_total, payment_status, payment_mode, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [req.companyId, supplier_id || null, bill_no || '', purchase_date, subtotal, totalGst, grandTotal, payment_status || 'unpaid', payment_mode || 'cash', notes || '']
    );

    const purchaseId = result.insertId;

    for (const item of normalizedItems) {
      if (!item.product_id) continue;
      await conn.query(
        `INSERT INTO purchase_items (purchase_id, product_id, qty, short_qty, damaged_qty, expired_qty, accepted_qty, rate, gst_rate, taxable_amount, gst_amount, total_amount, expiry_date, notes)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [purchaseId, item.product_id, item.qty, item.short_qty, item.damaged_qty, item.expired_qty, item.accepted_qty, item.rate, item.gst_rate, item.taxable_amount, item.gst_amount, item.total_amount, item.expiry_date || null, item.notes || '']
      );

      await conn.query(
        `INSERT INTO stock_movements (company_id, product_id, movement_date, movement_type, qty, reference_type, reference_id, notes)
         VALUES (?,?,?,?,?,?,?,?)`,
        [req.companyId, item.product_id, purchase_date, 'purchase_in', item.accepted_qty, 'purchase', purchaseId, item.notes || '']
      );

      if (item.damaged_qty > 0) {
        await conn.query(
          `INSERT INTO stock_movements (company_id, product_id, movement_date, movement_type, qty, reference_type, reference_id, notes)
           VALUES (?,?,?,?,?,?,?,?)`,
          [req.companyId, item.product_id, purchase_date, 'damage', item.damaged_qty, 'purchase', purchaseId, item.notes || '']
        );
      }

      if (item.expired_qty > 0) {
        await conn.query(
          `INSERT INTO stock_movements (company_id, product_id, movement_date, movement_type, qty, reference_type, reference_id, notes)
           VALUES (?,?,?,?,?,?,?,?)`,
          [req.companyId, item.product_id, purchase_date, 'expiry', item.expired_qty, 'purchase', purchaseId, item.notes || '']
        );
      }
    }

    await conn.commit();
    res.status(201).json({ success: true, message: 'Purchase bill created.', purchase_id: purchaseId });
  } catch (err) {
    await conn.rollback();
    console.error('Purchase create error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

module.exports = router;
