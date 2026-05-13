const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const { query } = require('../config/db');
const { authenticate } = require('../middleware/auth');

function jwtSecretOr500(res) {
  if (!process.env.JWT_SECRET) {
    console.error('JWT_SECRET is not set');
    res.status(500).json({ success: false, message: 'Server configuration error.' });
    return null;
  }
  return process.env.JWT_SECRET;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// POST /api/auth/register
router.post('/register', [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const msg = errors.array().map((e) => e.msg).join(' ');
    return res.status(400).json({ success: false, message: msg, errors: errors.array() });
  }

  const { email, password } = req.body;

  try {
    const [existing] = await query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) {
      return res.status(409).json({ success: false, message: 'Email already registered.' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const [result] = await query(
      'INSERT INTO users (email, password) VALUES (?, ?)',
      [email, hashedPassword]
    );

    const secret = jwtSecretOr500(res);
    if (!secret) return;

    const token = jwt.sign({ userId: result.insertId }, secret, {
      expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    });

    res.status(201).json({
      success: true,
      message: 'Account created successfully.',
      token,
      user: { id: result.insertId, email },
      hasCompany: false,
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// POST /api/auth/login
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const msg = errors.array().map((e) => e.msg).join(' ');
    return res.status(400).json({ success: false, message: msg, errors: errors.array() });
  }

  const { email, password } = req.body;

  try {
    const [users] = await query('SELECT * FROM users WHERE email = ?', [email]);
    if (users.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    const user = users[0];
    if (user.is_active === false || user.is_active === 0) {
      return res.status(403).json({ success: false, message: 'Your account is deactivated. Please contact admin.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    const isAdmin = user.is_admin === true || user.is_admin === 1;
    const [companies] = isAdmin ? [[]] : await query('SELECT id FROM companies WHERE user_id = ?', [user.id]);
    const hasCompany = companies.length > 0;

    const secret = jwtSecretOr500(res);
    if (!secret) return;

    const token = jwt.sign({ userId: user.id }, secret, {
      expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    });
    const decodedToken = jwt.decode(token);
    await query(
      'INSERT INTO user_sessions (user_id, token_hash, ip_address, user_agent, expires_at, is_active) VALUES (?, ?, ?, ?, ?, ?)',
      [
        user.id,
        tokenHash(token),
        req.ip || req.headers['x-forwarded-for'] || '',
        req.headers['user-agent'] || '',
        decodedToken?.exp ? new Date(decodedToken.exp * 1000).toISOString() : null,
        1,
      ]
    ).catch(() => {});

    res.json({
      success: true,
      message: 'Login successful.',
      token,
      user: { id: user.id, email: user.email, is_admin: isAdmin },
      hasCompany,
      isAdmin,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req, res) => {
  try {
    const [companies] = req.user.is_admin ? [[]] : await query('SELECT * FROM companies WHERE user_id = ?', [req.user.id]);
    res.json({
      success: true,
      user: req.user,
      company: companies.length > 0 ? companies[0] : null,
      hasCompany: companies.length > 0,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// POST /api/auth/change-password
router.post('/change-password', authenticate, [
  body('currentPassword').notEmpty(),
  body('newPassword').isLength({ min: 6 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const msg = errors.array().map((e) => e.msg).join(' ');
    return res.status(400).json({ success: false, message: msg, errors: errors.array() });
  }

  const { currentPassword, newPassword } = req.body;

  try {
    const [users] = await query('SELECT password FROM users WHERE id = ?', [req.user.id]);
    const isMatch = await bcrypt.compare(currentPassword, users[0].password);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Current password is incorrect.' });
    }

    const hashed = await bcrypt.hash(newPassword, 12);
    await query('UPDATE users SET password = ? WHERE id = ?', [hashed, req.user.id]);

    res.json({ success: true, message: 'Password changed successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

module.exports = router;
