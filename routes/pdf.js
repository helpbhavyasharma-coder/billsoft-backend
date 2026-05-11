const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const { authenticate, attachCompany } = require('../middleware/auth');
const { generatePDF, generateInvoiceHTML } = require('../services/pdfService');

router.use(authenticate, attachCompany);

// GET /api/pdf/invoice/:id
router.get('/invoice/:id', async (req, res) => {
  try {
    const [invoices] = await query(
      'SELECT * FROM invoices WHERE id = ? AND company_id = ?',
      [req.params.id, req.companyId]
    );
    if (invoices.length === 0) return res.status(404).json({ success: false, message: 'Invoice not found.' });

    const [companies] = await query('SELECT * FROM companies WHERE id = ?', [req.companyId]);
    const [parties] = await query('SELECT * FROM parties WHERE id = ?', [invoices[0].party_id]);
    const [items] = await query(
      'SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order ASC',
      [req.params.id]
    );

    const pdfBuffer = await generatePDF(companies[0], invoices[0], items, parties[0]);

    const cleanInvoiceNo = invoices[0].invoice_no.replace(/\//g, ' ');
    const cleanPartyName = (parties[0]?.name || '').replace(/[^a-zA-Z0-9\s]/g, '').trim();
    const fileName = `${cleanInvoiceNo} ${cleanPartyName}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('PDF generation error:', err);
    res.status(500).json({ success: false, message: 'Failed to generate PDF. ' + err.message });
  }
});

// GET /api/pdf/invoice/:id/preview
router.get('/invoice/:id/preview', async (req, res) => {
  try {
    const [invoices] = await query(
      'SELECT * FROM invoices WHERE id = ? AND company_id = ?',
      [req.params.id, req.companyId]
    );
    if (invoices.length === 0) return res.status(404).json({ success: false, message: 'Invoice not found.' });

    const [companies] = await query('SELECT * FROM companies WHERE id = ?', [req.companyId]);
    const [parties] = await query('SELECT * FROM parties WHERE id = ?', [invoices[0].party_id]);
    const [items] = await query(
      'SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order ASC',
      [req.params.id]
    );

    const html = await generateInvoiceHTML(companies[0], invoices[0], items, parties[0]);
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to generate preview.' });
  }
});

module.exports = router;
