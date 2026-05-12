const express = require('express');
const router = express.Router();
const { query, getConnection } = require('../config/db');
const { authenticate, attachCompany } = require('../middleware/auth');

router.use(authenticate, attachCompany);

const isPostgres = !!(process.env.DATABASE_URL);

// Invoice list ordering - PostgreSQL vs SQLite
const invoiceOrderSQL = isPostgres
  ? `CAST(SPLIT_PART(i.invoice_no, '/', 3) AS INTEGER) DESC, i.id DESC`
  : `CAST(SUBSTR(i.invoice_no, LENGTH(i.invoice_no) - 2) AS INTEGER) DESC, i.id DESC`;

// COALESCE for nullable update - PostgreSQL vs SQLite
const coalesceSQL = isPostgres
  ? `payment_status = COALESCE($${'{PS}'}, payment_status), amount_paid = COALESCE($${'{AP}'}, amount_paid)`
  : `payment_status=COALESCE(?,payment_status), amount_paid=COALESCE(?,amount_paid)`;

// GET /api/invoices/dashboard/stats  (must be before /:id)
router.get('/dashboard/stats', async (req, res) => {
  try {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = now.getFullYear();
    const monthPrefix = `${year}-${month}`;

    const [monthlySales] = await query(
      `SELECT COUNT(*) as count, COALESCE(SUM(grand_total), 0) as total
       FROM invoices WHERE company_id = ? AND status != 'cancelled'
       AND invoice_date LIKE ?`,
      [req.companyId, `${monthPrefix}%`]
    );

    const [unpaid] = await query(
      `SELECT COUNT(*) as count, COALESCE(SUM(grand_total - amount_paid), 0) as total
       FROM invoices WHERE company_id = ? AND payment_status IN ('unpaid','partial') AND status != 'cancelled'`,
      [req.companyId]
    );

    const [recentInvoices] = await query(
      `SELECT i.id, i.invoice_no, i.invoice_date, i.grand_total, i.payment_status,
       p.name as party_name FROM invoices i
       LEFT JOIN parties p ON i.party_id = p.id
       WHERE i.company_id = ? AND i.status != 'cancelled'
       ORDER BY i.created_at DESC LIMIT 5`,
      [req.companyId]
    );

    res.json({
      success: true,
      stats: {
        monthly_sales: monthlySales[0],
        outstanding: unpaid[0],
        recent_invoices: recentInvoices,
      },
    });
  } catch (err) {
    console.error('Dashboard stats error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// GET /api/invoices/next-number
router.get('/next-number', async (req, res) => {
  try {
    const [company] = await query(
      'SELECT invoice_prefix, invoice_counter, financial_year FROM companies WHERE id = ?',
      [req.companyId]
    );
    if (company.length === 0) return res.status(404).json({ success: false, message: 'Company not found.' });

    const { invoice_prefix, financial_year } = company[0];

    // Find highest ACTIVE invoice number
    const [lastActive] = await query(
      `SELECT invoice_no FROM invoices 
       WHERE company_id = ? AND status != 'cancelled'
       ORDER BY id DESC LIMIT 1`,
      [req.companyId]
    );

    let nextCounter = 1;

    if (lastActive.length > 0) {
      const parts = lastActive[0].invoice_no.split('/');
      const lastNum = parseInt(parts[parts.length - 1]);
      if (!isNaN(lastNum)) nextCounter = lastNum + 1;
    }

    // Take max of counter and calculated
    nextCounter = Math.max(nextCounter, company[0].invoice_counter);

    const invoiceNo = `${invoice_prefix}/${financial_year}/${String(nextCounter).padStart(3, '0')}`;
    res.json({ success: true, invoice_no: invoiceNo, counter: nextCounter });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// GET /api/invoices
router.get('/', async (req, res) => {
  try {
    const { search, status, from_date, to_date, party_id, page = 1, limit = 20 } = req.query;
    let sql = `
      SELECT i.*, p.name as party_name, p.mobile as party_mobile, p.gst_no as party_gst
      FROM invoices i
      LEFT JOIN parties p ON i.party_id = p.id
      WHERE i.company_id = ? AND i.status != 'cancelled'
    `;
    const params = [req.companyId];

    if (search) {
      if (isPostgres) {
        sql += ' AND (i.invoice_no ILIKE ? OR p.name ILIKE ?)';
      } else {
        sql += ' AND (i.invoice_no LIKE ? OR p.name LIKE ?)';
      }
      params.push(`%${search}%`, `%${search}%`);
    }
    if (status) { sql += ' AND i.status = ?'; params.push(status); }
    if (party_id) { sql += ' AND i.party_id = ?'; params.push(party_id); }
    if (from_date) { sql += ' AND i.invoice_date >= ?'; params.push(from_date); }
    if (to_date) { sql += ' AND i.invoice_date <= ?'; params.push(to_date); }

    // Count
    const countSql = sql.replace(
      'SELECT i.*, p.name as party_name, p.mobile as party_mobile, p.gst_no as party_gst',
      'SELECT COUNT(*) as total'
    );
    const [countResult] = await query(countSql, params);
    const total = countResult[0].total;

    sql += ` ORDER BY ${invoiceOrderSQL}`;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    sql += ` LIMIT ${parseInt(limit)} OFFSET ${offset}`;

    const [rows] = await query(sql, params);

    res.json({
      success: true,
      invoices: rows,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (err) {
    console.error('List invoices error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// GET /api/invoices/:id
router.get('/:id', async (req, res) => {
  try {
    const [invoices] = await query(
      `SELECT i.*, p.name as party_name, p.address as party_address, p.city as party_city,
       p.mobile as party_mobile, p.gst_no as party_gst, p.email as party_email
       FROM invoices i
       LEFT JOIN parties p ON i.party_id = p.id
       WHERE i.id = ? AND i.company_id = ?`,
      [req.params.id, req.companyId]
    );
    if (invoices.length === 0) return res.status(404).json({ success: false, message: 'Invoice not found.' });

    const [items] = await query(
      'SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order ASC',
      [req.params.id]
    );

    res.json({ success: true, invoice: invoices[0], items });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// Helper: calculate items
const calcItems = (items, isInterstate) => {
  let subtotal = 0, totalDiscount = 0, taxableAmount = 0;
  let totalCgst = 0, totalSgst = 0, totalIgst = 0;

  const processed = items.map((item, idx) => {
    const totalSale = parseFloat(item.qty || 0) * parseFloat(item.rate || 0);
    const discount = parseFloat(item.discount || 0);
    const taxable = (totalSale - discount) / (1 + parseFloat(item.gst_rate || 0) / 100);
    const gstAmt = (totalSale - discount) - taxable;

    let cgst = 0, sgst = 0, igst = 0;
    if (isInterstate) igst = gstAmt;
    else { cgst = gstAmt / 2; sgst = gstAmt / 2; }

    subtotal += totalSale;
    totalDiscount += discount;
    taxableAmount += taxable;
    totalCgst += cgst;
    totalSgst += sgst;
    totalIgst += igst;

    return {
      product_id: item.product_id || null,
      description: item.description,
      hsn_code: item.hsn_code || '',
      qty: parseFloat(item.qty || 1),
      unit: item.unit || 'Pcs',
      rate: parseFloat(item.rate || 0),
      total_sale: parseFloat(totalSale.toFixed(2)),
      discount: parseFloat(discount.toFixed(2)),
      taxable_amount: parseFloat(taxable.toFixed(2)),
      gst_rate: parseFloat(item.gst_rate || 5),
      cgst: parseFloat(cgst.toFixed(2)),
      sgst: parseFloat(sgst.toFixed(2)),
      igst: parseFloat(igst.toFixed(2)),
      sort_order: idx,
    };
  });

  const grandTotalRaw = taxableAmount + totalCgst + totalSgst + totalIgst;
  const grandTotal = Math.round(grandTotalRaw);
  const roundOff = parseFloat((grandTotal - grandTotalRaw).toFixed(2));

  return {
    processed,
    totals: {
      subtotal: parseFloat(subtotal.toFixed(2)),
      totalDiscount: parseFloat(totalDiscount.toFixed(2)),
      taxableAmount: parseFloat(taxableAmount.toFixed(2)),
      totalCgst: parseFloat(totalCgst.toFixed(2)),
      totalSgst: parseFloat(totalSgst.toFixed(2)),
      totalIgst: parseFloat(totalIgst.toFixed(2)),
      roundOff,
      grandTotal,
    },
  };
};

// POST /api/invoices
router.post('/', async (req, res) => {
  const conn = await getConnection();
  try {
    await conn.beginTransaction();

    const { party_id, invoice_no, invoice_date, due_date, invoice_type, supply_type, notes, terms, items } = req.body;

    if (!party_id || !invoice_date || !items || items.length === 0) {
      await conn.rollback();
      return res.status(400).json({ success: false, message: 'Party, date and items are required.' });
    }

    const [party] = await conn.query('SELECT id FROM parties WHERE id = ? AND company_id = ?', [party_id, req.companyId]);
    if (party.length === 0) {
      await conn.rollback();
      return res.status(400).json({ success: false, message: 'Invalid party.' });
    }

    let finalInvoiceNo = invoice_no;
    if (!finalInvoiceNo) {
      const [company] = await conn.query(
        'SELECT invoice_prefix, invoice_counter, financial_year FROM companies WHERE id = ?',
        [req.companyId]
      );
      const { invoice_prefix, invoice_counter, financial_year } = company[0];
      finalInvoiceNo = `${invoice_prefix}/${financial_year}/${String(invoice_counter).padStart(3, '0')}`;
    }

    const isInterstate = supply_type === 'interstate';
    const validItems = items.filter(i => i.description);
    const { processed, totals } = calcItems(validItems, isInterstate);

    const [invoiceResult] = await conn.query(
      `INSERT INTO invoices (company_id, party_id, invoice_no, invoice_date, due_date,
       invoice_type, supply_type, subtotal, total_discount, taxable_amount,
       total_cgst, total_sgst, total_igst, round_off, grand_total, notes, terms, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft')`,
      [
        req.companyId, party_id, finalInvoiceNo, invoice_date, due_date || null,
        invoice_type || 'GST', supply_type || 'intrastate',
        totals.subtotal, totals.totalDiscount, totals.taxableAmount,
        totals.totalCgst, totals.totalSgst, totals.totalIgst,
        totals.roundOff, totals.grandTotal, notes || '', terms || '',
      ]
    );

    const invoiceId = invoiceResult.insertId;

    for (const item of processed) {
      await conn.query(
        `INSERT INTO invoice_items (invoice_id, product_id, description, hsn_code, qty, unit,
         rate, total_sale, discount, taxable_amount, gst_rate, cgst, sgst, igst, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [invoiceId, item.product_id, item.description, item.hsn_code, item.qty, item.unit,
         item.rate, item.total_sale, item.discount, item.taxable_amount,
         item.gst_rate, item.cgst, item.sgst, item.igst, item.sort_order]
      );
    }

    // Update counter to last used number + 1
    const lastNum = parseInt(finalInvoiceNo.split('/').pop());
    if (!isNaN(lastNum)) {
      await conn.query(
        `UPDATE companies SET invoice_counter = ? WHERE id = ? AND invoice_counter <= ?`,
        [lastNum + 1, req.companyId, lastNum]
      );
    }

    await conn.commit();

    const [created] = await query(
      `SELECT i.*, p.name as party_name FROM invoices i
       LEFT JOIN parties p ON i.party_id = p.id WHERE i.id = ?`,
      [invoiceId]
    );
    const [createdItems] = await query('SELECT * FROM invoice_items WHERE invoice_id = ?', [invoiceId]);

    res.status(201).json({ success: true, message: 'Invoice created.', invoice: created[0], items: createdItems });
  } catch (err) {
    await conn.rollback();
    console.error('Create invoice error:', err);
    if (err.code === '23505' || (err.message && err.message.includes('UNIQUE'))) {
      return res.status(409).json({ success: false, message: 'Invoice number already exists.' });
    }
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

// PUT /api/invoices/:id
router.put('/:id', async (req, res) => {
  const conn = await getConnection();
  try {
    await conn.beginTransaction();

    const [existing] = await conn.query(
      'SELECT id FROM invoices WHERE id = ? AND company_id = ?',
      [req.params.id, req.companyId]
    );
    if (existing.length === 0) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: 'Invoice not found.' });
    }

    const { party_id, invoice_date, due_date, invoice_type, supply_type, notes, terms, items, status, payment_status, amount_paid } = req.body;

    const isInterstate = supply_type === 'interstate';
    const validItems = (items || []).filter(i => i.description);
    const { processed, totals } = calcItems(validItems, isInterstate);

    await conn.query(
      `UPDATE invoices SET party_id=?, invoice_date=?, due_date=?, invoice_type=?, supply_type=?,
       subtotal=?, total_discount=?, taxable_amount=?, total_cgst=?, total_sgst=?, total_igst=?,
       round_off=?, grand_total=?, notes=?, terms=?, status=?,
       payment_status=COALESCE(?,payment_status), amount_paid=COALESCE(?,amount_paid),
       updated_at=datetime('now') WHERE id=?`,
      [
        party_id, invoice_date, due_date || null, invoice_type || 'GST', supply_type || 'intrastate',
        totals.subtotal, totals.totalDiscount, totals.taxableAmount,
        totals.totalCgst, totals.totalSgst, totals.totalIgst,
        totals.roundOff, totals.grandTotal, notes || '', terms || '',
        status || 'draft', payment_status || null, amount_paid || null,
        req.params.id,
      ]
    );

    await conn.query('DELETE FROM invoice_items WHERE invoice_id = ?', [req.params.id]);
    for (const item of processed) {
      await conn.query(
        `INSERT INTO invoice_items (invoice_id, product_id, description, hsn_code, qty, unit,
         rate, total_sale, discount, taxable_amount, gst_rate, cgst, sgst, igst, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [req.params.id, item.product_id, item.description, item.hsn_code, item.qty, item.unit,
         item.rate, item.total_sale, item.discount, item.taxable_amount,
         item.gst_rate, item.cgst, item.sgst, item.igst, item.sort_order]
      );
    }

    await conn.commit();

    const [updated] = await query(
      `SELECT i.*, p.name as party_name FROM invoices i
       LEFT JOIN parties p ON i.party_id = p.id WHERE i.id = ?`,
      [req.params.id]
    );
    const [updatedItems] = await query('SELECT * FROM invoice_items WHERE invoice_id = ?', [req.params.id]);

    res.json({ success: true, message: 'Invoice updated.', invoice: updated[0], items: updatedItems });
  } catch (err) {
    await conn.rollback();
    console.error('Update invoice error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// DELETE /api/invoices/:id
router.delete('/:id', async (req, res) => {
  try {
    const [existing] = await query(
      'SELECT id, invoice_no FROM invoices WHERE id = ? AND company_id = ?',
      [req.params.id, req.companyId]
    );
    if (existing.length === 0) return res.status(404).json({ success: false, message: 'Invoice not found.' });

    const deletedInvoiceNo = existing[0].invoice_no;

    // Soft delete
    await query('UPDATE invoices SET status = ? WHERE id = ?', ['cancelled', req.params.id]);

    // Smart counter reset - check last active invoice number
    const [lastActive] = await query(
      `SELECT invoice_no FROM invoices
       WHERE company_id = ? AND status != 'cancelled'
       ORDER BY id DESC LIMIT 1`,
      [req.companyId]
    );

    if (lastActive.length === 0) {
      // No active invoices - reset to 1
      await query('UPDATE companies SET invoice_counter = 1 WHERE id = ?', [req.companyId]);
    } else {
      const parts = lastActive[0].invoice_no.split('/');
      const lastNum = parseInt(parts[parts.length - 1]);
      if (!isNaN(lastNum)) {
        await query('UPDATE companies SET invoice_counter = ? WHERE id = ?', [lastNum + 1, req.companyId]);
      }
    }

    res.json({ success: true, message: 'Invoice deleted.', deleted_no: deletedInvoiceNo });
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

module.exports = router;
