-- Billing Software Database Schema
-- Run this file to set up the database

CREATE DATABASE IF NOT EXISTS billing_software CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE billing_software;

-- Users table (each user = one company account)
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  is_verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Company profiles (linked to users)
CREATE TABLE IF NOT EXISTS companies (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL UNIQUE,
  company_name VARCHAR(255) NOT NULL,
  address TEXT,
  city VARCHAR(100),
  state VARCHAR(100),
  pincode VARCHAR(10),
  gst_no VARCHAR(20),
  fssai_no VARCHAR(30),
  pan_no VARCHAR(20),
  mobile VARCHAR(15),
  email VARCHAR(255),
  website VARCHAR(255),
  logo_url VARCHAR(500),
  bank_name VARCHAR(255),
  bank_account_no VARCHAR(50),
  bank_ifsc VARCHAR(20),
  bank_branch VARCHAR(100),
  upi_id VARCHAR(100),
  invoice_prefix VARCHAR(20) DEFAULT 'INV',
  invoice_counter INT DEFAULT 1,
  financial_year VARCHAR(10) DEFAULT '26-27',
  terms TEXT DEFAULT '1. Goods once sold will not be taken back\n2. Payment terms will be last for 7 days',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Products/Items master list
CREATE TABLE IF NOT EXISTS products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  hsn_code VARCHAR(20),
  unit VARCHAR(20) DEFAULT 'Pcs',
  default_rate DECIMAL(10,2) DEFAULT 0.00,
  gst_rate DECIMAL(5,2) DEFAULT 5.00,
  category VARCHAR(100),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

-- Parties/Customers master list
CREATE TABLE IF NOT EXISTS parties (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  address TEXT,
  city VARCHAR(100),
  state VARCHAR(100),
  mobile VARCHAR(15),
  email VARCHAR(255),
  gst_no VARCHAR(20) DEFAULT 'NA',
  party_type ENUM('customer', 'supplier', 'both') DEFAULT 'customer',
  opening_balance DECIMAL(12,2) DEFAULT 0.00,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

-- Invoices header
CREATE TABLE IF NOT EXISTS invoices (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  party_id INT NOT NULL,
  invoice_no VARCHAR(50) NOT NULL,
  invoice_date DATE NOT NULL,
  due_date DATE,
  invoice_type ENUM('GST', 'NON-GST') DEFAULT 'GST',
  supply_type ENUM('intrastate', 'interstate') DEFAULT 'intrastate',
  subtotal DECIMAL(12,2) DEFAULT 0.00,
  total_discount DECIMAL(12,2) DEFAULT 0.00,
  taxable_amount DECIMAL(12,2) DEFAULT 0.00,
  total_cgst DECIMAL(12,2) DEFAULT 0.00,
  total_sgst DECIMAL(12,2) DEFAULT 0.00,
  total_igst DECIMAL(12,2) DEFAULT 0.00,
  round_off DECIMAL(5,2) DEFAULT 0.00,
  grand_total DECIMAL(12,2) DEFAULT 0.00,
  amount_paid DECIMAL(12,2) DEFAULT 0.00,
  payment_status ENUM('unpaid', 'partial', 'paid') DEFAULT 'unpaid',
  notes TEXT,
  terms TEXT,
  status ENUM('draft', 'sent', 'cancelled') DEFAULT 'draft',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  FOREIGN KEY (party_id) REFERENCES parties(id),
  UNIQUE KEY unique_invoice (company_id, invoice_no)
);

-- Invoice line items
CREATE TABLE IF NOT EXISTS invoice_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  invoice_id INT NOT NULL,
  product_id INT,
  description VARCHAR(255) NOT NULL,
  hsn_code VARCHAR(20),
  qty DECIMAL(10,3) DEFAULT 1.000,
  unit VARCHAR(20) DEFAULT 'Pcs',
  rate DECIMAL(10,2) DEFAULT 0.00,
  total_sale DECIMAL(12,2) DEFAULT 0.00,
  discount DECIMAL(10,2) DEFAULT 0.00,
  taxable_amount DECIMAL(12,2) DEFAULT 0.00,
  gst_rate DECIMAL(5,2) DEFAULT 5.00,
  cgst DECIMAL(10,2) DEFAULT 0.00,
  sgst DECIMAL(10,2) DEFAULT 0.00,
  igst DECIMAL(10,2) DEFAULT 0.00,
  sort_order INT DEFAULT 0,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON SET NULL
);

-- Payments tracking
CREATE TABLE IF NOT EXISTS payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  invoice_id INT NOT NULL,
  party_id INT NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  payment_date DATE NOT NULL,
  payment_mode ENUM('cash', 'bank_transfer', 'upi', 'cheque', 'other') DEFAULT 'cash',
  reference_no VARCHAR(100),
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
  FOREIGN KEY (party_id) REFERENCES parties(id)
);

-- Indexes for performance
CREATE INDEX idx_invoices_company ON invoices(company_id);
CREATE INDEX idx_invoices_party ON invoices(party_id);
CREATE INDEX idx_invoices_date ON invoices(invoice_date);
CREATE INDEX idx_products_company ON products(company_id);
CREATE INDEX idx_parties_company ON parties(company_id);
CREATE INDEX idx_invoice_items_invoice ON invoice_items(invoice_id);
