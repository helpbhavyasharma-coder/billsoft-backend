const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const { authenticate } = require('../middleware/auth');

const isAdmin = async (req, res, next) => {
  try {
    if (req.user.is_admin) return next();
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
      `SELECT u.id, u.email, u.is_admin, u.is_active, u.created_at,
       c.id as company_id, c.company_name, c.business_type, c.gst_no, c.mobile, c.city, c.state,
       (SELECT COUNT(*) FROM invoices i WHERE i.company_id = c.id AND i.status != 'cancelled') as invoice_count,
       (SELECT COALESCE(SUM(grand_total),0) FROM invoices i WHERE i.company_id = c.id AND i.status != 'cancelled') as total_revenue,
       (SELECT COUNT(*) FROM parties p WHERE p.company_id = c.id AND p.is_active = 1) as party_count,
       (SELECT COUNT(*) FROM products pr WHERE pr.company_id = c.id AND pr.is_active = 1) as product_count
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

router.get('/users/:id', async (req, res) => {
  try {
    const [users] = await query(
      `SELECT u.id, u.email, u.is_admin, u.is_active, u.created_at,
       c.id as company_id, c.company_name, c.address, c.city, c.state, c.pincode, c.gst_no,
       c.fssai_no, c.pan_no, c.mobile, c.email as company_email, c.business_type, c.financial_year
       FROM users u
       LEFT JOIN companies c ON c.user_id = u.id
       WHERE u.id = ?`,
      [req.params.id]
    );
    if (users.length === 0) return res.status(404).json({ success: false, message: 'User not found.' });

    const companyId = users[0].company_id;
    const [invoiceStats] = companyId ? await query(
      `SELECT COUNT(*) as total, COALESCE(SUM(grand_total),0) as amount,
       COALESCE(SUM(amount_paid),0) as paid,
       COALESCE(SUM(grand_total - amount_paid),0) as outstanding
       FROM invoices WHERE company_id = ? AND status != 'cancelled'`,
      [companyId]
    ) : [[{ total: 0, amount: 0, paid: 0, outstanding: 0 }]];
    const [partyStats] = companyId ? await query('SELECT COUNT(*) as total FROM parties WHERE company_id = ? AND is_active = 1', [companyId]) : [[{ total: 0 }]];
    const [productStats] = companyId ? await query('SELECT COUNT(*) as total FROM products WHERE company_id = ? AND is_active = 1', [companyId]) : [[{ total: 0 }]];
    const [paymentStats] = companyId ? await query('SELECT COUNT(*) as total, COALESCE(SUM(amount),0) as amount FROM payments WHERE company_id = ?', [companyId]) : [[{ total: 0, amount: 0 }]];
    const [purchaseStats] = companyId ? await query('SELECT COUNT(*) as total, COALESCE(SUM(grand_total),0) as amount FROM purchase_bills WHERE company_id = ?', [companyId]).catch(() => [[{ total: 0, amount: 0 }]]) : [[{ total: 0, amount: 0 }]];
    const [activeDevices] = await query(
      "SELECT COUNT(*) as total FROM user_sessions WHERE user_id = ? AND is_active = 1 AND (expires_at IS NULL OR expires_at > ?)",
      [req.params.id, new Date().toISOString()]
    ).catch(() => [[{ total: 0 }]]);
    const [sessions] = await query(
      'SELECT id, ip_address, user_agent, last_seen_at, expires_at, is_active, created_at FROM user_sessions WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 25',
      [req.params.id]
    ).catch(() => [[]]);
    const [invoices] = companyId ? await query(
      `SELECT i.id, i.invoice_no, i.invoice_date, i.grand_total, i.amount_paid, i.payment_status, i.status,
       p.name as party_name FROM invoices i LEFT JOIN parties p ON p.id = i.party_id
       WHERE i.company_id = ? ORDER BY i.invoice_date DESC, i.id DESC`,
      [companyId]
    ) : [[]];
    const [parties] = companyId ? await query(
      'SELECT id, name, mobile, email, gst_no, party_type, opening_balance, is_active, created_at FROM parties WHERE company_id = ? ORDER BY name ASC',
      [companyId]
    ) : [[]];
    const [products] = companyId ? await query(
      'SELECT id, name, hsn_code, category, unit, default_rate, gst_rate, is_active, created_at FROM products WHERE company_id = ? ORDER BY name ASC',
      [companyId]
    ) : [[]];

    res.json({
      success: true,
      detail: {
        user: users[0],
        stats: {
          invoices: invoiceStats[0],
          parties: partyStats[0],
          products: productStats[0],
          payments: paymentStats[0],
          purchases: purchaseStats[0],
          active_devices: activeDevices[0],
        },
        lists: { invoices, parties, products, sessions },
        recent: { invoices: invoices.slice(0, 10), parties: parties.slice(0, 10), products: products.slice(0, 10) },
      },
    });
  } catch (err) {
    console.error('Admin user detail error:', err);
    res.status(500).json({ success: false, message: 'Server error: ' + err.message });
  }
});

router.patch('/users/:id/status', async (req, res) => {
  try {
    if (String(req.params.id) === String(req.user.id)) {
      return res.status(400).json({ success: false, message: 'You cannot change your own admin status.' });
    }
    const isActive = req.body.is_active ? 1 : 0;
    await query('UPDATE users SET is_active = ? WHERE id = ?', [isActive, req.params.id]);
    res.json({ success: true, message: isActive ? 'User activated.' : 'User deactivated.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

router.delete('/users/:id', async (req, res) => {
  try {
    if (String(req.params.id) === String(req.user.id)) {
      return res.status(400).json({ success: false, message: 'You cannot delete your own admin account.' });
    }
    await query('DELETE FROM users WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'User deleted.' });
  } catch (err) {
    console.error('Admin user delete error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
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
