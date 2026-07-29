const express = require('express');
const router = express.Router();
const { query, getConnection } = require('../config/db');
const { authenticate, attachCompany } = require('../middleware/auth');

router.use(authenticate, attachCompany);

async function nextReturnNo(conn, companyId) {
  const prefix = `GR-${new Date().getFullYear()}`;
  const [rows] = await conn.query(
    `SELECT return_no FROM goods_returns
     WHERE company_id = ? AND return_no LIKE ?
     ORDER BY id DESC LIMIT 1`,
    [companyId, `${prefix}-%`]
  );
  const last = rows[0]?.return_no ? parseInt(String(rows[0].return_no).split('-').pop(), 10) || 0 : 0;
  return `${prefix}-${String(last + 1).padStart(4, '0')}`;
}

async function refreshInvoiceStatus(conn, invoiceId, companyId) {
  const [rows] = await conn.query(
    `SELECT i.grand_total, i.amount_paid,
     COALESCE((SELECT SUM(amount) FROM goods_returns WHERE invoice_id = i.id), 0) as returned
     FROM invoices i WHERE i.id = ? AND i.company_id = ?`,
    [invoiceId, companyId]
  );
  if (!rows.length) return;
  const outstanding = Math.max(parseFloat(rows[0].grand_total || 0) - parseFloat(rows[0].amount_paid || 0) - parseFloat(rows[0].returned || 0), 0);
  const status = outstanding <= 0 ? 'paid' : parseFloat(rows[0].amount_paid || 0) > 0 || parseFloat(rows[0].returned || 0) > 0 ? 'partial' : 'unpaid';
  await conn.query(
    `UPDATE invoices SET payment_status = ?, updated_at = datetime('now') WHERE id = ? AND company_id = ?`,
    [status, invoiceId, companyId]
  );
}

router.get('/', async (req, res) => {
  try {
    const [returns] = await query(
      `SELECT gr.*, p.name as party_name, i.invoice_no
       FROM goods_returns gr
       JOIN parties p ON p.id = gr.party_id
       LEFT JOIN invoices i ON i.id = gr.invoice_id
       WHERE gr.company_id = ?
       ORDER BY gr.return_date DESC, gr.id DESC`,
      [req.companyId]
    );

    for (const row of returns) {
      const [items] = await query(
        `SELECT gri.*, pr.name as product_name
         FROM goods_return_items gri
         LEFT JOIN products pr ON pr.id = gri.product_id
         WHERE gri.return_id = ?
         ORDER BY gri.id ASC`,
        [row.id]
      ).catch(() => [[]]);
      row.items = items;
    }
    res.json({ success: true, returns });
  } catch (err) {
    console.error('Goods returns list error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

router.post('/', async (req, res) => {
  const conn = await getConnection();
  try {
    await conn.beginTransaction();
    const invoiceId = Number(req.body.invoice_id || 0);
    const [invoices] = await conn.query(
      `SELECT i.*, COALESCE((SELECT SUM(amount) FROM goods_returns WHERE invoice_id = i.id), 0) as returned_amount
       FROM invoices i WHERE i.id = ? AND i.company_id = ? AND i.status != 'cancelled'`,
      [invoiceId, req.companyId]
    );
    if (!invoices.length) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: 'Invoice not found.' });
    }
    const invoice = invoices[0];
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const returnItems = [];
    let amount = 0;

    if (items.length) {
      for (const item of items) {
        const invoiceItemId = Number(item.invoice_item_id || 0);
        const qty = parseFloat(item.qty || 0);
        if (!invoiceItemId || qty <= 0) continue;
        const [invoiceItems] = await conn.query(
          `SELECT * FROM invoice_items WHERE id = ? AND invoice_id = ?`,
          [invoiceItemId, invoiceId]
        );
        if (!invoiceItems.length) throw new Error('Invalid return item.');
        const invoiceItem = invoiceItems[0];
        const [returned] = await conn.query(
          `SELECT COALESCE(SUM(gri.qty),0) as qty
           FROM goods_return_items gri
           JOIN goods_returns gr ON gr.id = gri.return_id
           WHERE gr.company_id = ? AND gr.invoice_id = ? AND gri.invoice_item_id = ?`,
          [req.companyId, invoiceId, invoiceItemId]
        );
        const available = parseFloat(invoiceItem.qty || 0) - parseFloat(returned[0].qty || 0);
        if (qty > available) throw new Error(`Return quantity exceeds available quantity for ${invoiceItem.description}.`);
        const lineAmount = parseFloat(invoiceItem.total_sale || 0) * qty / Math.max(parseFloat(invoiceItem.qty || 0), 1);
        amount += lineAmount;
        returnItems.push({ invoiceItem, qty, amount: lineAmount });
      }
    } else {
      amount = parseFloat(req.body.amount || 0);
    }

    const pending = Math.max(parseFloat(invoice.grand_total || 0) - parseFloat(invoice.amount_paid || 0) - parseFloat(invoice.returned_amount || 0), 0);
    if (amount <= 0) throw new Error('Return amount or item quantity is required.');
    if (amount > pending) throw new Error(`Return exceeds pending invoice outstanding. Pending: ${pending.toFixed(2)}`);

    const returnNo = await nextReturnNo(conn, req.companyId);
    const [result] = await conn.query(
      `INSERT INTO goods_returns (company_id, party_id, invoice_id, return_no, return_date, amount, reason, notes)
       VALUES (?,?,?,?,?,?,?,?)`,
      [req.companyId, invoice.party_id, invoiceId, returnNo, req.body.return_date || new Date().toISOString().slice(0, 10), amount, req.body.reason || '', req.body.notes || '']
    );

    for (const item of returnItems) {
      await conn.query(
        `INSERT INTO goods_return_items (return_id, invoice_item_id, product_id, description, qty, amount)
         VALUES (?,?,?,?,?,?)`,
        [result.insertId, item.invoiceItem.id, item.invoiceItem.product_id, item.invoiceItem.description, item.qty, item.amount]
      );
      if (item.invoiceItem.product_id) {
        await conn.query(
          `INSERT INTO stock_movements (company_id, product_id, movement_date, movement_type, qty, reference_type, reference_id, notes)
           VALUES (?,?,?,?,?,?,?,?)`,
          [req.companyId, item.invoiceItem.product_id, req.body.return_date || new Date().toISOString().slice(0, 10), 'sale_return_in', item.qty, 'goods_return', result.insertId, `Goods return ${returnNo}`]
        );
      }
    }

    await refreshInvoiceStatus(conn, invoiceId, req.companyId);
    await conn.commit();
    res.status(201).json({ success: true, message: 'Goods return recorded.', return_id: result.insertId });
  } catch (err) {
    await conn.rollback();
    res.status(400).json({ success: false, message: err.message });
  } finally {
    if (conn.release) conn.release();
  }
});

router.delete('/:id', async (req, res) => {
  const conn = await getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT * FROM goods_returns WHERE id = ? AND company_id = ?', [req.params.id, req.companyId]);
    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: 'Goods return not found.' });
    }
    await conn.query("DELETE FROM stock_movements WHERE company_id = ? AND reference_type = 'goods_return' AND reference_id = ?", [req.companyId, req.params.id]);
    await conn.query('DELETE FROM goods_returns WHERE id = ? AND company_id = ?', [req.params.id, req.companyId]);
    if (rows[0].invoice_id) await refreshInvoiceStatus(conn, rows[0].invoice_id, req.companyId);
    await conn.commit();
    res.json({ success: true, message: 'Goods return deleted.' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, message: 'Server error.' });
  } finally {
    if (conn.release) conn.release();
  }
});

module.exports = router;
