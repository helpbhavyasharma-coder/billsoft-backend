require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;

// Create uploads directory
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// CORS: echo request Origin when present (needed with credentials + browsers hitting Railway from softbill etc.)
app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    callback(null, origin);
  },
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve uploaded files (logos etc.)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'Billing Software API is running', version: '1.0.0' });
});

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/company', require('./routes/company'));
app.use('/api/products', require('./routes/products'));
app.use('/api/parties', require('./routes/parties'));
app.use('/api/invoices', require('./routes/invoices'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/pdf', require('./routes/pdf'));

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ success: false, message: 'File too large. Max 2MB allowed.' });
  }
  res.status(500).json({ success: false, message: 'Internal server error.' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found.' });
});

app.listen(PORT, () => {
  console.log(`🚀 Billing Software API running on http://localhost:${PORT}`);
  console.log(`📄 Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
