const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { query } = require('../config/db');

const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Access denied. No token provided.' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const [rows] = await query('SELECT id, email, is_admin, is_active FROM users WHERE id = ?', [decoded.userId]);
    if (rows.length === 0) {
      return res.status(401).json({ success: false, message: 'User not found.' });
    }
    if (rows[0].is_active === false || rows[0].is_active === 0) {
      return res.status(403).json({ success: false, message: 'Account is deactivated.' });
    }

    req.user = { id: decoded.userId, email: rows[0].email, is_admin: !!rows[0].is_admin };
    await query(
      "UPDATE user_sessions SET last_seen_at = ?, is_active = ? WHERE token_hash = ?",
      [new Date().toISOString(), 1, crypto.createHash('sha256').update(token).digest('hex')]
    ).catch(() => {});
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Token expired. Please login again.' });
    }
    return res.status(401).json({ success: false, message: 'Invalid token.' });
  }
};

const attachCompany = async (req, res, next) => {
  try {
    const [rows] = await query('SELECT id FROM companies WHERE user_id = ?', [req.user.id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Company profile not found. Please complete setup.' });
    }
    req.companyId = rows[0].id;
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = { authenticate, attachCompany };
