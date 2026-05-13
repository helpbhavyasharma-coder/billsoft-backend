// Auto-detect: PostgreSQL (production/Railway) or SQLite (local development)
const isProduction = !!(process.env.DATABASE_URL);
const bcrypt = require('bcryptjs');

let query, getConnection;

if (isProduction) {
  // ── PostgreSQL (Railway / Production) ──
  const { Pool } = require('pg');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  pool.connect()
    .then(client => {
      console.log('✅ PostgreSQL connected');
      client.release();
      initPostgres(pool);
    })
    .catch(err => {
      console.error('❌ PostgreSQL connection failed:', err.message);
      process.exit(1);
    });

  const initPostgres = async (pool) => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) NOT NULL UNIQUE,
          password VARCHAR(255) NOT NULL,
          is_admin BOOLEAN DEFAULT FALSE,
          is_active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS companies (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
          company_name VARCHAR(255) NOT NULL,
          address TEXT, city VARCHAR(100), state VARCHAR(100), pincode VARCHAR(10),
          gst_no VARCHAR(20), fssai_no VARCHAR(30), pan_no VARCHAR(20),
          mobile VARCHAR(15), email VARCHAR(255), website VARCHAR(255),
          logo_url VARCHAR(500),
          bank_name VARCHAR(255), bank_account_no VARCHAR(50),
          bank_ifsc VARCHAR(20), bank_branch VARCHAR(100), upi_id VARCHAR(100),
          invoice_prefix VARCHAR(20) DEFAULT 'INV',
          invoice_counter INTEGER DEFAULT 1,
          financial_year VARCHAR(10) DEFAULT '26-27',
          business_type VARCHAR(50) DEFAULT 'general',
          terms TEXT DEFAULT '1. Goods once sold will not be taken back\n2. Payment terms will be last for 7 days',
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS products (
          id SERIAL PRIMARY KEY,
          company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
          name VARCHAR(255) NOT NULL,
          hsn_code VARCHAR(20), unit VARCHAR(20) DEFAULT 'Pcs',
          default_rate DECIMAL(10,2) DEFAULT 0,
          gst_rate DECIMAL(5,2) DEFAULT 5,
          category VARCHAR(100), is_active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS parties (
          id SERIAL PRIMARY KEY,
          company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
          name VARCHAR(255) NOT NULL,
          address TEXT, city VARCHAR(100), state VARCHAR(100),
          mobile VARCHAR(15), email VARCHAR(255),
          gst_no VARCHAR(20) DEFAULT 'NA',
          party_type VARCHAR(20) DEFAULT 'customer',
          opening_balance DECIMAL(12,2) DEFAULT 0,
          is_active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS invoices (
          id SERIAL PRIMARY KEY,
          company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
          party_id INTEGER NOT NULL REFERENCES parties(id),
          invoice_no VARCHAR(50) NOT NULL,
          invoice_date DATE NOT NULL, due_date DATE,
          invoice_type VARCHAR(10) DEFAULT 'GST',
          supply_type VARCHAR(20) DEFAULT 'intrastate',
          subtotal DECIMAL(12,2) DEFAULT 0,
          total_discount DECIMAL(12,2) DEFAULT 0,
          taxable_amount DECIMAL(12,2) DEFAULT 0,
          total_cgst DECIMAL(12,2) DEFAULT 0,
          total_sgst DECIMAL(12,2) DEFAULT 0,
          total_igst DECIMAL(12,2) DEFAULT 0,
          round_off DECIMAL(5,2) DEFAULT 0,
          grand_total DECIMAL(12,2) DEFAULT 0,
          amount_paid DECIMAL(12,2) DEFAULT 0,
          payment_status VARCHAR(20) DEFAULT 'unpaid',
          notes TEXT, terms TEXT,
          status VARCHAR(20) DEFAULT 'draft',
          created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(company_id, invoice_no)
        );

        CREATE TABLE IF NOT EXISTS invoice_items (
          id SERIAL PRIMARY KEY,
          invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
          product_id INTEGER,
          description VARCHAR(255) NOT NULL,
          hsn_code VARCHAR(20), qty DECIMAL(10,3) DEFAULT 1,
          unit VARCHAR(20) DEFAULT 'Pcs', rate DECIMAL(10,2) DEFAULT 0,
          total_sale DECIMAL(12,2) DEFAULT 0, discount DECIMAL(10,2) DEFAULT 0,
          taxable_amount DECIMAL(12,2) DEFAULT 0, gst_rate DECIMAL(5,2) DEFAULT 5,
          cgst DECIMAL(10,2) DEFAULT 0, sgst DECIMAL(10,2) DEFAULT 0,
          igst DECIMAL(10,2) DEFAULT 0, sort_order INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS payments (
          id SERIAL PRIMARY KEY,
          company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
          invoice_id INTEGER REFERENCES invoices(id) ON DELETE CASCADE,
          party_id INTEGER NOT NULL REFERENCES parties(id),
          amount DECIMAL(12,2) NOT NULL,
          payment_date DATE NOT NULL,
          payment_type VARCHAR(20) DEFAULT 'invoice',
          payment_mode VARCHAR(30) DEFAULT 'cash',
          reference_no VARCHAR(100), notes TEXT,
          created_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS purchase_bills (
          id SERIAL PRIMARY KEY,
          company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
          supplier_id INTEGER REFERENCES parties(id),
          bill_no VARCHAR(100),
          purchase_date DATE NOT NULL,
          subtotal DECIMAL(12,2) DEFAULT 0,
          total_gst DECIMAL(12,2) DEFAULT 0,
          grand_total DECIMAL(12,2) DEFAULT 0,
          payment_status VARCHAR(20) DEFAULT 'unpaid',
          payment_mode VARCHAR(30) DEFAULT 'cash',
          notes TEXT,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS purchase_items (
          id SERIAL PRIMARY KEY,
          purchase_id INTEGER NOT NULL REFERENCES purchase_bills(id) ON DELETE CASCADE,
          product_id INTEGER REFERENCES products(id),
          qty DECIMAL(12,3) DEFAULT 0,
          short_qty DECIMAL(12,3) DEFAULT 0,
          damaged_qty DECIMAL(12,3) DEFAULT 0,
          expired_qty DECIMAL(12,3) DEFAULT 0,
          accepted_qty DECIMAL(12,3) DEFAULT 0,
          rate DECIMAL(12,2) DEFAULT 0,
          gst_rate DECIMAL(5,2) DEFAULT 0,
          taxable_amount DECIMAL(12,2) DEFAULT 0,
          gst_amount DECIMAL(12,2) DEFAULT 0,
          total_amount DECIMAL(12,2) DEFAULT 0,
          expiry_date DATE,
          notes TEXT
        );

        CREATE TABLE IF NOT EXISTS stock_movements (
          id SERIAL PRIMARY KEY,
          company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
          product_id INTEGER NOT NULL REFERENCES products(id),
          movement_date DATE NOT NULL,
          movement_type VARCHAR(30) NOT NULL,
          qty DECIMAL(12,3) DEFAULT 0,
          reference_type VARCHAR(30),
          reference_id INTEGER,
          notes TEXT,
          created_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS ledger_accounts (
          id SERIAL PRIMARY KEY,
          company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
          name VARCHAR(255) NOT NULL,
          account_type VARCHAR(20) DEFAULT 'bank',
          account_no VARCHAR(100),
          ifsc VARCHAR(30),
          branch VARCHAR(100),
          opening_balance DECIMAL(12,2) DEFAULT 0,
          is_active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS ledger_entries (
          id SERIAL PRIMARY KEY,
          company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
          account_id INTEGER NOT NULL REFERENCES ledger_accounts(id) ON DELETE CASCADE,
          entry_date DATE NOT NULL,
          entry_type VARCHAR(10) NOT NULL,
          amount DECIMAL(12,2) NOT NULL,
          description TEXT,
          reference_no VARCHAR(100),
          reference_type VARCHAR(30),
          reference_id INTEGER,
          created_at TIMESTAMP DEFAULT NOW()
        );
      `);
      await pool.query(`ALTER TABLE payments ALTER COLUMN invoice_id DROP NOT NULL`).catch(() => {});
      await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_type VARCHAR(20) DEFAULT 'invoice'`).catch(() => {});
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE`).catch(() => {});
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE`).catch(() => {});
      if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
        const hashed = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
        await pool.query(
          `INSERT INTO users (email, password, is_admin, is_active)
           VALUES ($1, $2, TRUE, TRUE)
           ON CONFLICT (email) DO UPDATE SET password = EXCLUDED.password, is_admin = TRUE, is_active = TRUE`,
          [process.env.ADMIN_EMAIL.toLowerCase(), hashed]
        ).catch(() => {});
      }
      console.log('✅ PostgreSQL schema initialized');
    } catch (err) {
      console.error('Schema init error:', err.message);
    }
  };

  // PostgreSQL query wrapper - same interface as SQLite
  query = async (sql, params = []) => {
    // Convert SQLite ? placeholders to PostgreSQL $1, $2...
    let pgSql = sql;
    let i = 0;
    pgSql = pgSql.replace(/\?/g, () => `$${++i}`);

    // Convert SQLite functions to PostgreSQL
    pgSql = pgSql.replace(/datetime\('now'\)/g, 'NOW()');
    pgSql = pgSql.replace(/strftime\('%m',\s*([^)]+)\)/g, (_, col) => `TO_CHAR(${col}, 'MM')`);
    pgSql = pgSql.replace(/strftime\('%Y',\s*([^)]+)\)/g, (_, col) => `TO_CHAR(${col}, 'YYYY')`);
    // SQLite boolean to PostgreSQL
    pgSql = pgSql.replace(/is_active\s*=\s*1/g, 'is_active = TRUE');
    pgSql = pgSql.replace(/is_active\s*=\s*0/g, 'is_active = FALSE');
    pgSql = pgSql.replace(/SET is_active = TRUE/g, 'SET is_active = TRUE');
    pgSql = pgSql.replace(/SET is_active = FALSE/g, 'SET is_active = FALSE');

    // Auto-add RETURNING id for INSERT statements
    const upper = pgSql.trim().toUpperCase();
    if (upper.startsWith('INSERT') && !upper.includes('RETURNING')) {
      pgSql = pgSql + ' RETURNING id';
    }

    const result = await pool.query(pgSql, params);

    if (upper.startsWith('INSERT')) {
      const insertId = result.rows?.[0]?.id;
      return [{ insertId, affectedRows: result.rowCount, rows: result.rows }];
    }
    return [result.rows || []];
  };

  getConnection = async () => {
    const client = await pool.connect();
    return {
      query: async (sql, params = []) => {
        let pgSql = sql;
        let i = 0;
        pgSql = pgSql.replace(/\?/g, () => `$${++i}`);
        pgSql = pgSql.replace(/datetime\('now'\)/g, 'NOW()');
        pgSql = pgSql.replace(/strftime\('%m',\s*([^)]+)\)/g, (_, col) => `TO_CHAR(${col}, 'MM')`);
        pgSql = pgSql.replace(/strftime\('%Y',\s*([^)]+)\)/g, (_, col) => `TO_CHAR(${col}, 'YYYY')`);
        pgSql = pgSql.replace(/is_active\s*=\s*1/g, 'is_active = TRUE');
        pgSql = pgSql.replace(/is_active\s*=\s*0/g, 'is_active = FALSE');

        const upper = pgSql.trim().toUpperCase();
        if (upper.startsWith('INSERT') && !upper.includes('RETURNING')) {
          pgSql = pgSql + ' RETURNING id';
        }

        const result = await client.query(pgSql, params);

        if (upper.startsWith('INSERT')) {
          return [{ insertId: result.rows?.[0]?.id, affectedRows: result.rowCount }];
        }
        return [result.rows || []];
      },
      beginTransaction: () => client.query('BEGIN'),
      commit: () => client.query('COMMIT'),
      rollback: () => client.query('ROLLBACK'),
      release: () => client.release(),
    };
  };

} else {
  // ── SQLite (Local Development) ──
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (e) {
    console.error('better-sqlite3 not available - set DATABASE_URL for PostgreSQL');
    // Keep retrying instead of crashing
    setInterval(() => {
      console.log('Waiting for DATABASE_URL...');
    }, 5000);
    return;
  }
  const path = require('path');
  const fs = require('fs');

  const DB_PATH = path.join(__dirname, '../database/billing.db');
  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      company_name TEXT NOT NULL,
      address TEXT, city TEXT, state TEXT, pincode TEXT,
      gst_no TEXT, fssai_no TEXT, pan_no TEXT,
      mobile TEXT, email TEXT, website TEXT, logo_url TEXT,
      bank_name TEXT, bank_account_no TEXT, bank_ifsc TEXT, bank_branch TEXT, upi_id TEXT,
      invoice_prefix TEXT DEFAULT 'INV',
      invoice_counter INTEGER DEFAULT 1,
      financial_year TEXT DEFAULT '26-27',
      business_type TEXT DEFAULT 'general',
      terms TEXT DEFAULT '1. Goods once sold will not be taken back
2. Payment terms will be last for 7 days',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      name TEXT NOT NULL, hsn_code TEXT, unit TEXT DEFAULT 'Pcs',
      default_rate REAL DEFAULT 0, gst_rate REAL DEFAULT 5,
      category TEXT, is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS parties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      name TEXT NOT NULL, address TEXT, city TEXT, state TEXT,
      mobile TEXT, email TEXT, gst_no TEXT DEFAULT 'NA',
      party_type TEXT DEFAULT 'customer',
      opening_balance REAL DEFAULT 0, is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL, party_id INTEGER NOT NULL,
      invoice_no TEXT NOT NULL, invoice_date TEXT NOT NULL, due_date TEXT,
      invoice_type TEXT DEFAULT 'GST', supply_type TEXT DEFAULT 'intrastate',
      subtotal REAL DEFAULT 0, total_discount REAL DEFAULT 0,
      taxable_amount REAL DEFAULT 0, total_cgst REAL DEFAULT 0,
      total_sgst REAL DEFAULT 0, total_igst REAL DEFAULT 0,
      round_off REAL DEFAULT 0, grand_total REAL DEFAULT 0,
      amount_paid REAL DEFAULT 0, payment_status TEXT DEFAULT 'unpaid',
      notes TEXT, terms TEXT, status TEXT DEFAULT 'draft',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (party_id) REFERENCES parties(id),
      UNIQUE(company_id, invoice_no)
    );
    CREATE TABLE IF NOT EXISTS invoice_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL, product_id INTEGER,
      description TEXT NOT NULL, hsn_code TEXT,
      qty REAL DEFAULT 1, unit TEXT DEFAULT 'Pcs',
      rate REAL DEFAULT 0, total_sale REAL DEFAULT 0,
      discount REAL DEFAULT 0, taxable_amount REAL DEFAULT 0,
      gst_rate REAL DEFAULT 5, cgst REAL DEFAULT 0,
      sgst REAL DEFAULT 0, igst REAL DEFAULT 0, sort_order INTEGER DEFAULT 0,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL, invoice_id INTEGER,
      party_id INTEGER NOT NULL, amount REAL NOT NULL,
      payment_date TEXT NOT NULL, payment_type TEXT DEFAULT 'invoice', payment_mode TEXT DEFAULT 'cash',
      reference_no TEXT, notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS purchase_bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      supplier_id INTEGER,
      bill_no TEXT,
      purchase_date TEXT NOT NULL,
      subtotal REAL DEFAULT 0,
      total_gst REAL DEFAULT 0,
      grand_total REAL DEFAULT 0,
      payment_status TEXT DEFAULT 'unpaid',
      payment_mode TEXT DEFAULT 'cash',
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (supplier_id) REFERENCES parties(id)
    );
    CREATE TABLE IF NOT EXISTS purchase_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_id INTEGER NOT NULL,
      product_id INTEGER,
      qty REAL DEFAULT 0,
      short_qty REAL DEFAULT 0,
      damaged_qty REAL DEFAULT 0,
      expired_qty REAL DEFAULT 0,
      accepted_qty REAL DEFAULT 0,
      rate REAL DEFAULT 0,
      gst_rate REAL DEFAULT 0,
      taxable_amount REAL DEFAULT 0,
      gst_amount REAL DEFAULT 0,
      total_amount REAL DEFAULT 0,
      expiry_date TEXT,
      notes TEXT,
      FOREIGN KEY (purchase_id) REFERENCES purchase_bills(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
    CREATE TABLE IF NOT EXISTS stock_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      movement_date TEXT NOT NULL,
      movement_type TEXT NOT NULL,
      qty REAL DEFAULT 0,
      reference_type TEXT,
      reference_id INTEGER,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
    CREATE TABLE IF NOT EXISTS ledger_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      account_type TEXT DEFAULT 'bank',
      account_no TEXT,
      ifsc TEXT,
      branch TEXT,
      opening_balance REAL DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      entry_date TEXT NOT NULL,
      entry_type TEXT NOT NULL,
      amount REAL NOT NULL,
      description TEXT,
      reference_no TEXT,
      reference_type TEXT,
      reference_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
      FOREIGN KEY (account_id) REFERENCES ledger_accounts(id) ON DELETE CASCADE
    );
  `);

  // Migration
  try { db.prepare("ALTER TABLE companies ADD COLUMN business_type TEXT DEFAULT 'general'").run(); } catch {}
  try { db.prepare("ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0").run(); } catch {}
  try { db.prepare("ALTER TABLE users ADD COLUMN is_active INTEGER DEFAULT 1").run(); } catch {}
  try { db.prepare("ALTER TABLE payments ADD COLUMN payment_type TEXT DEFAULT 'invoice'").run(); } catch {}
  try {
    if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
      const email = process.env.ADMIN_EMAIL.toLowerCase();
      const hashed = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 12);
      const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      if (existing) {
        db.prepare('UPDATE users SET password = ?, is_admin = 1, is_active = 1 WHERE email = ?').run(hashed, email);
      } else {
        db.prepare('INSERT INTO users (email, password, is_admin, is_active) VALUES (?, ?, 1, 1)').run(email, hashed);
      }
    }
  } catch {}
  try {
    const cols = db.prepare("PRAGMA table_info(payments)").all();
    const invoiceIdCol = cols.find((col) => col.name === 'invoice_id');
    if (invoiceIdCol?.notnull) {
      db.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE IF NOT EXISTS payments_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          company_id INTEGER NOT NULL, invoice_id INTEGER,
          party_id INTEGER NOT NULL, amount REAL NOT NULL,
          payment_date TEXT NOT NULL, payment_type TEXT DEFAULT 'invoice', payment_mode TEXT DEFAULT 'cash',
          reference_no TEXT, notes TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
          FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
        );
        INSERT INTO payments_new (id, company_id, invoice_id, party_id, amount, payment_date, payment_type, payment_mode, reference_no, notes, created_at)
        SELECT id, company_id, invoice_id, party_id, amount, payment_date, COALESCE(payment_type, 'invoice'), payment_mode, reference_no, notes, created_at FROM payments;
        DROP TABLE payments;
        ALTER TABLE payments_new RENAME TO payments;
        PRAGMA foreign_keys = ON;
      `);
    }
  } catch {}

  console.log('✅ SQLite Database initialized (local)');

  query = (sql, params = []) => {
    try {
      const stmt = db.prepare(sql);
      const upper = sql.trim().toUpperCase();
      if (upper.startsWith('SELECT') || upper.startsWith('WITH')) {
        return Promise.resolve([stmt.all(...(Array.isArray(params) ? params : [params]))]);
      } else {
        const info = stmt.run(...(Array.isArray(params) ? params : [params]));
        return Promise.resolve([{ insertId: info.lastInsertRowid, affectedRows: info.changes }]);
      }
    } catch (err) {
      return Promise.reject(err);
    }
  };

  getConnection = () => {
    let inTx = false;
    const conn = {
      query: (sql, params = []) => query(sql, params),
      beginTransaction: () => { db.prepare('BEGIN').run(); inTx = true; return Promise.resolve(); },
      commit: () => { if (inTx) { db.prepare('COMMIT').run(); inTx = false; } return Promise.resolve(); },
      rollback: () => { if (inTx) { db.prepare('ROLLBACK').run(); inTx = false; } return Promise.resolve(); },
      release: () => {},
    };
    return Promise.resolve(conn);
  };
}

module.exports = { query, getConnection };
