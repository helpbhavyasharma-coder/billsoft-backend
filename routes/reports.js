const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const { authenticate, attachCompany } = require('../middleware/auth');

router.use(authenticate, attachCompany);

const isPostgres = !!(process.env.DATABASE_URL);

// Helper: date functions for SQLite vs PostgreSQL
const monthExpr = (col) => isPostgres ? `TO_CHAR(${col}, 'MM')` : `strftime('%m', ${col})`;
const yearExpr = (col) => isPostgres ? `TO_CHAR(${col}, 'YYYY')` : `strftime('%Y', ${col})`;

// GET /api/reports/dashboard
router.get('/dashboard', async (req, res) => {
  try {
    const { year } = req.query;
    const currentYear = year || new Date().getFullYear();

    // Monthly sales for chart (12 months)
    const [monthlySales] = await query(
      `SELECT ${monthExpr('invoice_date')} as month,
       COUNT(*) as count,
       COALESCE(SUM(grand_total), 0) as total,
       COALESCE(SUM(total_cgst + total_sgst + total_igst), 0) as tax_total
       FROM invoices
       WHERE company_id = ? AND status != 'cancelled'
       AND ${yearExpr('invoice_date')} = ?
       GROUP BY ${monthExpr('invoice_date')}
       ORDER BY month ASC`,
      [req.companyId, String(currentYear)]
    );

    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const monthlyData = months.map((name, idx) => {
      const m = String(idx + 1).padStart(2, '0');
      const found = monthlySales.find(r => r.month === m);
      return {
        month: name,
        sales: found ? parseFloat(found.total) : 0,
        invoices: found ? parseInt(found.count) : 0,
        tax: found ? parseFloat(found.tax_total) : 0,
      };
    });

    // Top 5 customers
    const [topCustomers] = await query(
      `SELECT p.name, p.mobile,
       COUNT(i.id) as invoice_count,
       COALESCE(SUM(i.grand_total), 0) as total_business
       FROM invoices i
       LEFT JOIN parties p ON i.party_id = p.id
       WHERE i.company_id = ? AND i.status != 'cancelled'
       AND ${yearExpr('i.invoice_date')} = ?
       GROUP BY i.party_id, p.name, p.mobile
       ORDER BY total_business DESC LIMIT 5`,
      [req.companyId, String(currentYear)]
    );

    // Top 5 products
    const [topProducts] = await query(
      `SELECT ii.description,
       SUM(ii.qty) as total_qty,
       SUM(ii.total_sale) as total_sale
       FROM invoice_items ii
       JOIN invoices i ON ii.invoice_id = i.id
       WHERE i.company_id = ? AND i.status != 'cancelled'
       AND ${yearExpr('i.invoice_date')} = ?
       GROUP BY ii.description
       ORDER BY total_sale DESC LIMIT 5`,
      [req.companyId, String(currentYear)]
    );

    // Current month stats
    const now = new Date();
    const monthPrefix = isPostgres
      ? null
      : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    let thisMonth;
    if (isPostgres) {
      const [r] = await query(
        `SELECT COUNT(*) as count, COALESCE(SUM(grand_total), 0) as total
         FROM invoices WHERE company_id = ? AND status != 'cancelled'
         AND EXTRACT(MONTH FROM invoice_date) = ? AND EXTRACT(YEAR FROM invoice_date) = ?`,
        [req.companyId, now.getMonth() + 1, now.getFullYear()]
      );
      thisMonth = r;
    } else {
      const [r] = await query(
        `SELECT COUNT(*) as count, COALESCE(SUM(grand_total), 0) as total
         FROM invoices WHERE company_id = ? AND status != 'cancelled'
         AND invoice_date LIKE ?`,
        [req.companyId, `${monthPrefix}%`]
      );
      thisMonth = r;
    }

    // Outstanding
    const [outstanding] = await query(
      `SELECT COUNT(*) as count, COALESCE(SUM(grand_total - amount_paid), 0) as total
       FROM invoices WHERE company_id = ? AND payment_status IN ('unpaid','partial') AND status != 'cancelled'`,
      [req.companyId]
    );

    // Total year sales
    const [yearTotal] = await query(
      `SELECT COALESCE(SUM(grand_total), 0) as total, COUNT(*) as count
       FROM invoices WHERE company_id = ? AND status != 'cancelled'
       AND ${yearExpr('invoice_date')} = ?`,
      [req.companyId, String(currentYear)]
    );

    // Recent invoices
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
      data: {
        monthly_chart: monthlyData,
        top_customers: topCustomers,
        top_products: topProducts,
        this_month: thisMonth[0],
        outstanding: outstanding[0],
        year_total: yearTotal[0],
        recent_invoices: recentInvoices,
        year: currentYear,
      },
    });
  } catch (err) {
    console.error('Dashboard report error:', err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

// GET /api/reports/party-ledger/:partyId
router.get('/party-ledger/:partyId', async (req, res) => {
  try {
    const [party] = await query(
      'SELECT * FROM parties WHERE id = ? AND company_id = ?',
      [req.params.partyId, req.companyId]
    );
    if (party.length === 0) return res.status(404).json({ success: false, message: 'Party not found.' });

    const [invoices] = await query(
      `SELECT i.*,
       COALESCE((SELECT SUM(amount) FROM payments WHERE invoice_id = i.id), 0) as paid_amount
       FROM invoices i
       WHERE i.party_id = ? AND i.company_id = ? AND i.status != 'cancelled'
       ORDER BY i.invoice_date ASC, i.id ASC`,
      [req.params.partyId, req.companyId]
    );

    const [allPayments] = await query(
      `SELECT p.*, i.invoice_no
       FROM payments p
       LEFT JOIN invoices i ON p.invoice_id = i.id
       WHERE p.party_id = ? AND p.company_id = ?
       ORDER BY p.payment_date DESC, p.id DESC`,
      [req.params.partyId, req.companyId]
    );

    const [summary] = await query(
      `SELECT
       COUNT(*) as total_invoices,
       COALESCE(SUM(grand_total), 0) as total_amount,
       COALESCE(SUM(amount_paid), 0) as total_paid,
       COALESCE(SUM(grand_total - amount_paid), 0) as invoice_outstanding
       FROM invoices
       WHERE party_id = ? AND company_id = ? AND status != 'cancelled'`,
      [req.params.partyId, req.companyId]
    );

    const openingBalance = parseFloat(party[0].opening_balance || 0);
    const invoiceOutstanding = parseFloat(summary[0].invoice_outstanding || 0);
    const enrichedSummary = {
      ...summary[0],
      opening_balance: openingBalance,
      outstanding: invoiceOutstanding + openingBalance,
    };

    res.json({
      success: true,
      party: party[0],
      invoices,
      payments: allPayments,
      summary: enrichedSummary,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// GET /api/reports/accountant — detailed bill-wise report for accountant
router.get('/accountant', async (req, res) => {
  try {
    const { from_date, to_date, year, month } = req.query;

    let dateFilter = '';
    let params = [req.companyId];

    if (from_date && to_date) {
      dateFilter = isPostgres
        ? ' AND i.invoice_date >= ? AND i.invoice_date <= ?'
        : ' AND i.invoice_date >= ? AND i.invoice_date <= ?';
      params.push(from_date, to_date);
    } else if (year && month) {
      if (isPostgres) {
        dateFilter = ' AND EXTRACT(YEAR FROM i.invoice_date) = ? AND EXTRACT(MONTH FROM i.invoice_date) = ?';
        params.push(parseInt(year), parseInt(month));
      } else {
        const prefix = `${year}-${String(month).padStart(2, '0')}`;
        dateFilter = ' AND i.invoice_date LIKE ?';
        params.push(`${prefix}%`);
      }
    } else if (year) {
      if (isPostgres) {
        dateFilter = ' AND EXTRACT(YEAR FROM i.invoice_date) = ?';
        params.push(parseInt(year));
      } else {
        dateFilter = ` AND ${yearExpr('i.invoice_date')} = ?`;
        params.push(String(year));
      }
    }

    // Bill-wise detail with party GST info
    const [invoices] = await query(
      `SELECT
        i.id, i.invoice_no, i.invoice_date, i.invoice_type, i.supply_type,
        i.subtotal, i.total_discount, i.taxable_amount,
        i.total_cgst, i.total_sgst, i.total_igst,
        (i.total_cgst + i.total_sgst + i.total_igst) as total_tax,
        i.grand_total, i.amount_paid,
        (i.grand_total - i.amount_paid) as balance,
        i.payment_status,
        p.name as party_name, p.gst_no as party_gst, p.city as party_city, p.state as party_state,
        CASE WHEN p.gst_no IS NOT NULL AND p.gst_no != 'NA' AND p.gst_no != '' THEN 1 ELSE 0 END as has_gstin
       FROM invoices i
       LEFT JOIN parties p ON i.party_id = p.id
       WHERE i.company_id = ? AND i.status != 'cancelled'
       ${dateFilter}
       ORDER BY i.invoice_date ASC, i.invoice_no ASC`,
      params
    );

    // HSN/Tax rate wise summary
    const [hsnSummary] = await query(
      `SELECT
        ii.hsn_code, ii.gst_rate,
        SUM(ii.qty) as total_qty,
        SUM(ii.taxable_amount) as taxable_amount,
        SUM(ii.cgst) as total_cgst,
        SUM(ii.sgst) as total_sgst,
        SUM(ii.igst) as total_igst,
        SUM(ii.cgst + ii.sgst + ii.igst) as total_tax
       FROM invoice_items ii
       JOIN invoices i ON ii.invoice_id = i.id
       WHERE i.company_id = ? AND i.status != 'cancelled'
       ${dateFilter}
       GROUP BY ii.hsn_code, ii.gst_rate
       ORDER BY ii.gst_rate ASC`,
      params
    );

    // Overall totals
    const [totals] = await query(
      `SELECT
        COUNT(*) as total_invoices,
        COALESCE(SUM(subtotal),0) as total_subtotal,
        COALESCE(SUM(total_discount),0) as total_discount,
        COALESCE(SUM(taxable_amount),0) as total_taxable,
        COALESCE(SUM(total_cgst),0) as total_cgst,
        COALESCE(SUM(total_sgst),0) as total_sgst,
        COALESCE(SUM(total_igst),0) as total_igst,
        COALESCE(SUM(total_cgst + total_sgst + total_igst),0) as total_tax,
        COALESCE(SUM(grand_total),0) as total_grand,
        COALESCE(SUM(amount_paid),0) as total_paid,
        COALESCE(SUM(grand_total - amount_paid),0) as total_outstanding
       FROM invoices i
       WHERE i.company_id = ? AND i.status != 'cancelled'
       ${dateFilter}`,
      params
    );

    // Party-wise GST summary
    const [partyGstSummary] = await query(
      `SELECT
        p.name as party_name, p.gst_no as party_gst,
        CASE WHEN p.gst_no IS NOT NULL AND p.gst_no != 'NA' AND p.gst_no != '' THEN 1 ELSE 0 END as has_gstin,
        COUNT(i.id) as invoice_count,
        COALESCE(SUM(i.taxable_amount),0) as taxable_amount,
        COALESCE(SUM(i.total_cgst + i.total_sgst + i.total_igst),0) as total_tax,
        COALESCE(SUM(i.grand_total),0) as grand_total
       FROM invoices i
       LEFT JOIN parties p ON i.party_id = p.id
       WHERE i.company_id = ? AND i.status != 'cancelled'
       ${dateFilter}
       GROUP BY i.party_id, p.name, p.gst_no
       ORDER BY grand_total DESC`,
      params
    );

    res.json({
      success: true,
      invoices,
      hsn_summary: hsnSummary,
      totals: totals[0],
      party_gst_summary: partyGstSummary,
      filters: { from_date, to_date, year, month },
    });
  } catch (err) {
    console.error('Accountant report error:', err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

// GET /api/reports/gst-summary
router.get('/gst-summary', async (req, res) => {
  try {
    const { month, year } = req.query;
    const currentYear = year || new Date().getFullYear();
    const currentMonth = month || String(new Date().getMonth() + 1).padStart(2, '0');

    let summaryQuery, params;
    if (isPostgres) {
      summaryQuery = `SELECT COUNT(*) as total_invoices,
       COALESCE(SUM(subtotal), 0) as total_sales,
       COALESCE(SUM(total_discount), 0) as total_discount,
       COALESCE(SUM(taxable_amount), 0) as taxable_amount,
       COALESCE(SUM(total_cgst), 0) as total_cgst,
       COALESCE(SUM(total_sgst), 0) as total_sgst,
       COALESCE(SUM(total_igst), 0) as total_igst,
       COALESCE(SUM(total_cgst + total_sgst + total_igst), 0) as total_tax,
       COALESCE(SUM(grand_total), 0) as grand_total
       FROM invoices
       WHERE company_id = ? AND status != 'cancelled'
       AND EXTRACT(MONTH FROM invoice_date) = ? AND EXTRACT(YEAR FROM invoice_date) = ?`;
      params = [req.companyId, parseInt(currentMonth), parseInt(currentYear)];
    } else {
      const prefix = `${currentYear}-${String(currentMonth).padStart(2, '0')}`;
      summaryQuery = `SELECT COUNT(*) as total_invoices,
       COALESCE(SUM(subtotal), 0) as total_sales,
       COALESCE(SUM(total_discount), 0) as total_discount,
       COALESCE(SUM(taxable_amount), 0) as taxable_amount,
       COALESCE(SUM(total_cgst), 0) as total_cgst,
       COALESCE(SUM(total_sgst), 0) as total_sgst,
       COALESCE(SUM(total_igst), 0) as total_igst,
       COALESCE(SUM(total_cgst + total_sgst + total_igst), 0) as total_tax,
       COALESCE(SUM(grand_total), 0) as grand_total
       FROM invoices
       WHERE company_id = ? AND status != 'cancelled' AND invoice_date LIKE ?`;
      params = [req.companyId, `${prefix}%`];
    }

    const [summary] = await query(summaryQuery, params);
    res.json({ success: true, summary: summary[0], month: currentMonth, year: currentYear });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

module.exports = router;
// Updated: 2026-05-12 06:49:29
