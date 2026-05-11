const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');

const numberToWords = (num) => {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  if (num === 0) return 'Zero';
  if (num < 0) return 'Minus ' + numberToWords(-num);

  let words = '';
  if (Math.floor(num / 10000000) > 0) {
    words += numberToWords(Math.floor(num / 10000000)) + ' Crore ';
    num %= 10000000;
  }
  if (Math.floor(num / 100000) > 0) {
    words += numberToWords(Math.floor(num / 100000)) + ' Lakh ';
    num %= 100000;
  }
  if (Math.floor(num / 1000) > 0) {
    words += numberToWords(Math.floor(num / 1000)) + ' Thousand ';
    num %= 1000;
  }
  if (Math.floor(num / 100) > 0) {
    words += numberToWords(Math.floor(num / 100)) + ' Hundred ';
    num %= 100;
  }
  if (num > 0) {
    if (num < 20) words += ones[num];
    else words += tens[Math.floor(num / 10)] + (num % 10 !== 0 ? ' ' + ones[num % 10] : '');
  }
  return words.trim();
};

const amountInWords = (amount) => {
  const rupees = Math.floor(amount);
  const paise = Math.round((amount - rupees) * 100);
  let result = numberToWords(rupees) + ' Rupees';
  if (paise > 0) result += ' and ' + numberToWords(paise) + ' Paise';
  return result + ' Only';
};

const formatDate = (dateStr) => {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const day = String(d.getDate()).padStart(2, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${day}/${months[d.getMonth()]}/${d.getFullYear()}`;
};

const generateInvoiceHTML = async (company, invoice, items, party) => {
  // Logo - base64 mein convert karo PDF ke liye
  let logoSrc = null;
  if (company.logo_url) {
    try {
      if (company.logo_url.startsWith('http')) {
        const https = require('https');
        const http = require('http');
        const protocol = company.logo_url.startsWith('https') ? https : http;
        logoSrc = await new Promise((resolve, reject) => {
          protocol.get(company.logo_url, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
              const buffer = Buffer.concat(chunks);
              const mime = res.headers['content-type'] || 'image/png';
              resolve(`data:${mime};base64,${buffer.toString('base64')}`);
            });
            res.on('error', reject);
          }).on('error', reject);
        });
      } else {
        const fs = require('fs');
        const path = require('path');
        const localPath = path.join(__dirname, '..', company.logo_url);
        if (fs.existsSync(localPath)) {
          const buffer = fs.readFileSync(localPath);
          const ext = path.extname(localPath).slice(1) || 'png';
          logoSrc = `data:image/${ext};base64,${buffer.toString('base64')}`;
        }
      }
    } catch (e) {
      console.error('Logo load error:', e.message);
    }
  }

  // Generate UPI QR code as base64 image
  let qrDataUrl = null;
  if (company.upi_id) {
    try {
      // UPI deep link format
      const upiString = `upi://pay?pa=${company.upi_id}&pn=${encodeURIComponent(company.company_name)}&am=${invoice.grand_total}&cu=INR`;
      qrDataUrl = await QRCode.toDataURL(upiString, {
        width: 80,
        margin: 1,
        color: { dark: '#000000', light: '#ffffff' },
      });
    } catch (e) {
      console.error('QR generation failed:', e.message);
    }
  }

  const itemRows = items.map((item, idx) => `
    <tr>
      <td class="center">${idx + 1}</td>
      <td>${item.description}</td>
      <td class="center">${item.hsn_code || ''}</td>
      <td class="center">${parseFloat(item.qty).toFixed(2)}</td>
      <td class="center">${item.unit}</td>
      <td class="right">${parseFloat(item.rate).toFixed(2)}</td>
      <td class="right">${parseFloat(item.total_sale).toFixed(2)}</td>
      <td class="right">${parseFloat(item.discount).toFixed(2)}</td>
      <td class="right">${parseFloat(item.taxable_amount).toFixed(2)}</td>
      <td class="center">${parseFloat(item.gst_rate).toFixed(2)}%</td>
      <td class="right">${parseFloat(item.cgst).toFixed(2)}</td>
      <td class="right">${parseFloat(item.sgst).toFixed(2)}</td>
      <td class="right">${parseFloat(item.igst).toFixed(2)}</td>
    </tr>
  `).join('');

  // Minimum 10 rows total - empty rows fill karo
  const MIN_ROWS = 10;
  const emptyRowsCount = Math.max(0, MIN_ROWS - items.length);
  const emptyRowsHTML = Array(emptyRowsCount).fill(`
    <tr style="height:20px">
      <td></td><td></td><td></td><td></td><td></td><td></td>
      <td></td><td></td><td></td><td></td><td></td><td></td><td></td>
    </tr>
  `).join('');

  const terms = (invoice.terms || company.terms || '').split('\n').filter(Boolean);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Invoice ${invoice.invoice_no}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, sans-serif; font-size: 10px; color: #000; background: #fff; }
  .invoice-wrapper { width: 190mm; padding: 4mm 5mm; margin: 0 auto; }

  /* Outer wrapper box - pura invoice ek box mein */
  .invoice-box { border: 2px solid #000; }

  /* Header */
  .header { display: flex; align-items: center; border-bottom: 1.5px solid #000; padding: 6px 10px; }
  .logo { width: 65px; height: 65px; object-fit: contain; margin-right: 12px; }
  .logo-placeholder { width: 65px; height: 65px; border: 1px dashed #ccc; display: flex; align-items: center; justify-content: center; margin-right: 12px; font-size: 8px; color: #999; }
  .company-info { flex: 1; text-align: center; }
  .company-name { font-size: 22px; font-weight: bold; color: #c00; text-decoration: underline; margin-bottom: 3px; }
  .company-address { font-size: 9px; color: #444; }

  /* Meta row */
  .meta-row { display: flex; border-bottom: 1.5px solid #000; font-size: 9px; }
  .meta-cell { flex: 1; padding: 3px 8px; border-right: 1px solid #000; }
  .meta-cell:last-child { border-right: none; }

  /* Invoice title */
  .invoice-title { text-align: center; font-size: 12px; font-weight: bold; text-decoration: underline; padding: 3px; border-bottom: 1.5px solid #000; letter-spacing: 1px; }

  /* Party section */
  .party-section { display: flex; border-bottom: 1.5px solid #000; }
  .party-left { flex: 1.6; padding: 5px 8px; border-right: 1.5px solid #000; }
  .party-right { flex: 1; padding: 5px 8px; }
  .party-row { display: flex; margin-bottom: 2px; font-size: 9px; line-height: 1.4; }
  .party-label { font-weight: bold; min-width: 65px; }

  /* Items table */
  .items-table { width: 100%; border-collapse: collapse; border-bottom: 1.5px solid #000; }
  .items-table th { border: 1px solid #555; padding: 3px 3px; font-size: 8px; background: #e8e8e8; font-weight: bold; text-align: center; line-height: 1.3; }
  .items-table td { border: 1px solid #888; padding: 2px 3px; font-size: 8.5px; line-height: 1.4; }
  .items-table td.center { text-align: center; }
  .items-table td.right { text-align: right; }
  .total-row td { font-weight: bold; background: #d0d0d0; font-size: 9px; border: 1px solid #555; }

  /* Amount in words */
  .amount-words { border-bottom: 1.5px solid #000; padding: 3px 8px; font-size: 9px; }

  /* Footer */
  .footer-section { display: flex; border-bottom: 1.5px solid #000; }
  .bank-section { flex: 1.3; padding: 5px 8px; border-right: 1.5px solid #000; font-size: 9px; line-height: 1.6; }
  .qr-section { width: 90px; padding: 4px 6px; border-right: 1.5px solid #000; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .summary-section { flex: 1; padding: 3px 8px; font-size: 9px; }
  .summary-row { display: flex; justify-content: space-between; padding: 1.5px 0; border-bottom: 1px dotted #bbb; }
  .summary-row.grand { font-weight: bold; font-size: 10.5px; border-top: 2px solid #000; border-bottom: none; padding-top: 3px; margin-top: 2px; background: #f0f0f0; }

  /* Terms + sign */
  .terms-sign { display: flex; }
  .terms-box { flex: 2; padding: 5px 8px; font-size: 8.5px; border-right: 1.5px solid #000; line-height: 1.6; }
  .sign-box { flex: 1; padding: 5px 8px; text-align: right; font-size: 9px; }
  .scan-label { font-size: 7px; font-weight: bold; margin-bottom: 3px; text-align: center; }
  .upi-text { font-size: 7px; color: #555; text-align: center; word-break: break-all; }
  .bank-title { font-weight: bold; text-decoration: underline; margin-bottom: 3px; font-size: 9px; }
</style>
</head>
<body>
<div class="invoice-wrapper">
<div class="invoice-box">

  <!-- Header -->
  <div class="header">
    ${logoSrc
      ? `<img src="${logoSrc}" class="logo" alt="Logo" />`
      : `<div class="logo-placeholder">LOGO</div>`
    }
    <div class="company-info">
      <div class="company-name">${company.company_name}</div>
      <div class="company-address">
        ${company.address ? company.address + ', ' : ''}${company.city || ''} ${company.pincode ? '- ' + company.pincode : ''} ${company.state || ''}
      </div>
    </div>
  </div>

  <!-- GST / FSSAI / Contact -->
  <div class="meta-row">
    <div class="meta-cell"><b>GST No. :</b> ${company.gst_no || 'N/A'}</div>
    ${company.fssai_no ? `<div class="meta-cell"><b>FSSAI No. :</b> ${company.fssai_no}</div>` : '<div class="meta-cell"></div>'}
    <div class="meta-cell" style="text-align:right"><b>CONTACT :</b> ${company.mobile || ''}</div>
  </div>

  <!-- Invoice Title -->
  <div class="invoice-title">GST INVOICE</div>

  <!-- Party Details -->
  <div class="party-section">
    <div class="party-left">
      <div class="party-row"><span class="party-label">Party</span><span>${party.name}</span></div>
      <div class="party-row"><span class="party-label">Address</span><span>${party.address || ''} ${party.city || ''}</span></div>
      <div class="party-row"><span class="party-label">Mobile</span><span>${party.mobile || ''}</span></div>
      <div class="party-row"><span class="party-label">GST No.</span><span>${party.gst_no || 'NA'}</span></div>
    </div>
    <div class="party-right">
      <div class="party-row"><span class="party-label">Invoice No.</span><span><b>${invoice.invoice_no}</b></span></div>
      <div class="party-row"><span class="party-label">Date</span><span><b>${formatDate(invoice.invoice_date)}</b></span></div>
      ${invoice.due_date ? `<div class="party-row"><span class="party-label">Due Date</span><span>${formatDate(invoice.due_date)}</span></div>` : ''}
    </div>
  </div>

  <!-- Items Table -->
  <table class="items-table">
    <thead>
      <tr>
        <th style="width:25px">Sr.</th>
        <th>Description</th>
        <th style="width:40px">HSN</th>
        <th style="width:40px">Qty</th>
        <th style="width:30px">Unit</th>
        <th style="width:45px">Rate</th>
        <th style="width:55px">Total Sale</th>
        <th style="width:40px">Dis.</th>
        <th style="width:60px">Taxable Amt</th>
        <th style="width:40px">GST%</th>
        <th style="width:45px">CGST</th>
        <th style="width:45px">SGST</th>
        <th style="width:45px">IGST</th>
      </tr>
    </thead>
    <tbody>
      ${itemRows}
      ${emptyRowsHTML}
      <tr class="total-row">
        <td colspan="6" class="center"><b>TOTAL</b></td>
        <td class="right"><b>${parseFloat(invoice.subtotal).toFixed(2)}</b></td>
        <td class="right"><b>${parseFloat(invoice.total_discount).toFixed(2)}</b></td>
        <td class="right"><b>${parseFloat(invoice.taxable_amount).toFixed(2)}</b></td>
        <td></td>
        <td class="right"><b>${parseFloat(invoice.total_cgst).toFixed(2)}</b></td>
        <td class="right"><b>${parseFloat(invoice.total_sgst).toFixed(2)}</b></td>
        <td class="right"><b>${parseFloat(invoice.total_igst).toFixed(2)}</b></td>
      </tr>
    </tbody>
  </table>

  <!-- Amount in Words -->
  <div class="amount-words">
    <b>Amount in Words:</b> ${amountInWords(parseFloat(invoice.grand_total))}
  </div>

  <!-- Footer: Bank + QR + Summary -->
  <div class="footer-section">
    <div class="bank-section">
      <div class="bank-title">BANK DETAILS</div>
      ${company.bank_name ? `<div><b>${company.bank_name}</b></div>` : ''}
      ${company.bank_account_no ? `<div>A/C NO. - ${company.bank_account_no}</div>` : ''}
      ${company.bank_ifsc ? `<div>IFSC - ${company.bank_ifsc}</div>` : ''}
      ${company.bank_branch ? `<div>BRANCH - ${company.bank_branch}</div>` : ''}
    </div>
    <div class="qr-section">
      <div class="scan-label">SCAN &amp; PAY</div>
      ${qrDataUrl
        ? `<img src="${qrDataUrl}" style="width:72px;height:72px;" alt="UPI QR" />`
        : company.upi_id
        ? `<div class="upi-text">UPI:<br/>${company.upi_id}</div>`
        : '<div class="upi-text" style="color:#aaa">No UPI</div>'
      }
      ${company.upi_id ? `<div class="upi-text" style="margin-top:2px">${company.upi_id}</div>` : ''}
    </div>
    <div class="summary-section">
      <div class="summary-row"><span>Total Invoice Value</span><span><b>${parseFloat(invoice.subtotal).toFixed(2)}</b></span></div>
      <div class="summary-row"><span>Total Discount</span><span>${parseFloat(invoice.total_discount).toFixed(2)}</span></div>
      <div class="summary-row"><span>Taxable Value</span><span>${parseFloat(invoice.taxable_amount).toFixed(2)}</span></div>
      <div class="summary-row"><span>Total CGST</span><span>${parseFloat(invoice.total_cgst).toFixed(2)}</span></div>
      <div class="summary-row"><span>Total SGST</span><span>${parseFloat(invoice.total_sgst).toFixed(2)}</span></div>
      <div class="summary-row"><span>Total IGST</span><span>${parseFloat(invoice.total_igst).toFixed(2)}</span></div>
      <div class="summary-row"><span>Round Off</span><span>${parseFloat(invoice.round_off).toFixed(2)}</span></div>
      <div class="summary-row grand"><span>GRAND TOTAL</span><span>&#8377; ${parseFloat(invoice.grand_total).toFixed(2)}</span></div>
    </div>
  </div>

  <!-- Terms + Signature -->
  <div class="terms-sign">
    <div class="terms-box">
      <div style="font-weight:bold;margin-bottom:3px;text-decoration:underline">Terms</div>
      ${terms.map((t, i) => `<div>${i + 1}. ${t.replace(/^\d+\.\s*/, '')}</div>`).join('')}
    </div>
    <div class="sign-box">
      <div style="font-weight:bold">For ${company.company_name}</div>
      <br/><br/><br/>
      <div>Authorized Signatory</div>
    </div>
  </div>

</div><!-- invoice-box -->
</div><!-- invoice-wrapper -->
</body>
</html>`;
};

const generatePDF = async (company, invoice, items, party) => {
  const html = await generateInvoiceHTML(company, invoice, items, party);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '5mm', bottom: '5mm', left: '5mm', right: '5mm' },
    });

    return pdfBuffer;
  } finally {
    await browser.close();
  }
};

module.exports = { generatePDF, generateInvoiceHTML };
