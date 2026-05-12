const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const { authenticate } = require('../middleware/auth');

// Simple admin check: first registered user (id=1) or ADMIN_EMAIL env var
const isAdmin = async (req, res, next) => {
  try {
    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail) {
      if (req.user.email === adminEmail) return next();
      return res.status(403).json({ success: false, message: 'Admin access required.' });
    }
    // Fallback: first user (id=1) is admin
    if (req.user.id === 1) return next();
    return res.status(403).json({ success: false, message: 'Admin access required.' });
  } catch (err) {
    next(err);
  }
};

router.use(authenticate, isAdmin);

// GET /api/admin/stats — overall platform stats
router.get('/stats', async (req, res) => {
  try {
    const [users] = await query('SELECT COUNT(*) as total FROM users', []);
    const [companies] = await query('SELECT COUNT(*) as total FROM companies', []);
    const [invoices] = await query(
      "SELECT COUNT(*) as total, COALESCE(SUM(grand_total),0) as revenue FROM invoices WHERE status != 'cancelled'", []
    );
    const [parties] = await query('SELECT COUNT(*) as total FROM parties WHERE is_active = 1', []);
    const [payments] = await query('SELECT COALESCE(SUM(amount),0) as total FROM payments', []);

    res.json({
      success: true,
      stats: {
        total_users: users[0]?.total || 0,
        total_companies: companies[0]?.total || 0,
        total_invoices: invoices[0]?.total || 0,
        total_revenue: invoices[0]?.revenue || 0,
        total_parties: parties[0]?.total || 0,
        total_payments: payments[0]?.total || 0,
      },
    });
  } catch (err) {
    console.error('Admin stats error:', err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

// GET /api/admin/users — all users with company info
router.get('/users', async (req, res) => {
  try {
    const [rows] = await query(
      `SELECT u.id, u.email, u.created_at,
       c.id as company_id, c.company_name, c.business_type, c.gst_no, c.mobile, c.city, c.state,
       (SELECT COUNT(*) FROM invoices i WHERE i.company_id = c.id AND i.status != 'cancelled') as invoice_count,
       (SELECT COALESCE(SUM(grand_total),0) FROM invoices i WHERE i.company_id = c.id AND i.status != 'cancelled') as total_revenue,
       (SELECT COUNT(*) FROM parties p WHERE p.company_id = c.id AND p.is_active = 1) as party_count
       FROM users u
       LEFT JOIN companies c ON c.user_id = u.id
       ORDER BY u.created_at DESC`,
      []
    );
    res.json({ success: true, users: rows });
  } catch (err) {
    console.error('Admin users error:', err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

// GET /api/admin/companies — all companies with stats
router.get('/companies', async (req, res) => {
  try {
    const [rows] = await query(
      `SELECT c.*,
       u.email as user_email,
       (SELECT COUNT(*) FROM invoices i WHERE i.company_id = c.id AND i.status != 'cancelled') as invoice_count,
       (SELECT COALESCE(SUM(grand_total),0) FROM invoices i WHERE i.company_id = c.id AND i.status != 'cancelled') as total_revenue,
       (SELECT COALESCE(SUM(grand_total - amount_paid),0) FROM invoices i WHERE i.company_id = c.id AND i.payment_status IN ('unpaid','partial') AND i.status != 'cancelled') as outstanding,
       (SELECT COUNT(*) FROM parties p WHERE p.company_id = c.id AND p.is_active = 1) as party_count
       FROM companies c
       JOIN users u ON u.id = c.user_id
       ORDER BY c.created_at DESC`,
      []
    );
    res.json({ success: true, companies: rows });
  } catch (err) {
    console.error('Admin companies error:', err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

module.exports = router;
