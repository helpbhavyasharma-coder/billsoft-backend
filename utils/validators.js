const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

function normalizeGstin(value) {
  return String(value || '').trim().toUpperCase();
}

function isValidGstinOrNA(value) {
  const gstin = normalizeGstin(value);
  return !gstin || gstin === 'NA' || GSTIN_PATTERN.test(gstin);
}

module.exports = { normalizeGstin, isValidGstinOrNA };
