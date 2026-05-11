const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { query } = require('../config/db');
const { authenticate } = require('../middleware/auth');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../uploads/logos');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `logo_${req.user.id}_${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    if (allowed.test(path.extname(file.originalname).toLowerCase())) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
});

// GET /api/company
router.get('/', authenticate, async (req, res) => {
  try {
    const [rows] = await query('SELECT * FROM companies WHERE user_id = ?', [req.user.id]);
    res.json({ success: true, company: rows.length > 0 ? rows[0] : null });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// POST /api/company - Create or update
router.post('/', authenticate, upload.single('logo'), async (req, res) => {
  try {
    const {
      company_name, address, city, state, pincode,
      gst_no, fssai_no, pan_no, mobile, email, website,
      bank_name, bank_account_no, bank_ifsc, bank_branch, upi_id,
      invoice_prefix, financial_year, terms, business_type,
    } = req.body;

    if (!company_name) {
      return res.status(400).json({ success: false, message: 'Company name is required.' });
    }

    let logo_url = null;
    if (req.file) logo_url = `/uploads/logos/${req.file.filename}`;

    const [existing] = await query('SELECT id, logo_url FROM companies WHERE user_id = ?', [req.user.id]);

    if (existing.length > 0) {
      // Update
      if (logo_url && existing[0].logo_url) {
        const oldPath = path.join(__dirname, '..', existing[0].logo_url);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }

      const logoField = logo_url ? ', logo_url = ?' : '';
      const params = [
        company_name, address || '', city || '', state || '', pincode || '',
        gst_no || '', fssai_no || '', pan_no || '', mobile || '', email || '', website || '',
        bank_name || '', bank_account_no || '', bank_ifsc || '', bank_branch || '', upi_id || '',
        invoice_prefix || 'INV', financial_year || '26-27', terms || '',
        business_type || 'general',
      ];
      if (logo_url) params.push(logo_url);
      params.push(req.user.id);

      await query(
        `UPDATE companies SET
          company_name=?, address=?, city=?, state=?, pincode=?,
          gst_no=?, fssai_no=?, pan_no=?, mobile=?, email=?, website=?,
          bank_name=?, bank_account_no=?, bank_ifsc=?, bank_branch=?, upi_id=?,
          invoice_prefix=?, financial_year=?, terms=?, business_type=?${logoField},
          updated_at=datetime('now')
         WHERE user_id=?`,
        params
      );

      const [updated] = await query('SELECT * FROM companies WHERE user_id = ?', [req.user.id]);
      return res.json({ success: true, message: 'Company profile updated.', company: updated[0] });
    } else {
      // Insert
      const [result] = await query(
        `INSERT INTO companies (
          user_id, company_name, address, city, state, pincode,
          gst_no, fssai_no, pan_no, mobile, email, website, logo_url,
          bank_name, bank_account_no, bank_ifsc, bank_branch, upi_id,
          invoice_prefix, financial_year, terms, business_type
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          req.user.id, company_name, address || '', city || '', state || '', pincode || '',
          gst_no || '', fssai_no || '', pan_no || '', mobile || '', email || '', website || '',
          logo_url || null, bank_name || '', bank_account_no || '', bank_ifsc || '',
          bank_branch || '', upi_id || '', invoice_prefix || 'INV',
          financial_year || '26-27',
          terms || '1. Goods once sold will not be taken back\n2. Payment terms will be last for 7 days',
          business_type || 'general',
        ]
      );

      const [created] = await query('SELECT * FROM companies WHERE id = ?', [result.insertId]);
      return res.status(201).json({ success: true, message: 'Company profile created.', company: created[0] });
    }
  } catch (err) {
    console.error('Company save error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

module.exports = router;
