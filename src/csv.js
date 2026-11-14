// CSV parsing + phone number validation / normalisation.
import { parse } from 'csv-parse/sync';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

export const DEFAULT_COUNTRY = 'PK'; // +92

const NAME_HEADERS = ['name', 'full name', 'fullname', 'contact'];
const NUMBER_HEADERS = ['number', 'phone', 'mobile', 'phone number', 'whatsapp', 'contact number'];

// Returns { number: '923001234567', display: '+92 300 1234567', mobile: true } or null if invalid.
// mobile is false for landlines, which normally cannot receive WhatsApp messages.
export function normaliseNumber(raw, country = DEFAULT_COUNTRY) {
  const cleaned = String(raw ?? '').trim();
  if (!cleaned) return null;

  // 1) As written (handles 0300..., +92..., 0092..., 300...).
  let phone = parsePhoneNumberFromString(cleaned, country);
  // 2) International number typed without the "+", e.g. 923001234567.
  if (!phone?.isValid()) {
    const digits = cleaned.replace(/\D/g, '');
    if (digits) phone = parsePhoneNumberFromString('+' + digits);
  }
  if (!phone?.isValid()) return null;

  const type = phone.getType();
  return {
    number: phone.number.replace('+', ''),
    display: phone.formatInternational(),
    mobile: type === 'MOBILE' || type === 'FIXED_LINE_OR_MOBILE',
  };
}

// Returns { rows: [...], summary: {...} }. Throws an Error with a readable message
// if the file itself is unusable (e.g. missing columns).
export function parseContacts(csvText) {
  let records;
  try {
    records = parse(csvText, {
      bom: true,
      columns: (header) => header.map((h) => String(h).trim().toLowerCase()),
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    });
  } catch (err) {
    throw new Error('Could not read the CSV file: ' + err.message);
  }

  if (!records.length) throw new Error('The CSV file has no rows.');

  const headers = Object.keys(records[0]);
  const nameKey = NAME_HEADERS.find((h) => headers.includes(h));
  const numberKey = NUMBER_HEADERS.find((h) => headers.includes(h));
  if (!nameKey || !numberKey) {
    throw new Error(
      `The CSV needs a "name" column and a "number" column. Found: ${headers.join(', ') || '(none)'}`
    );
  }

  const seen = new Map(); // normalised number -> first row number
  const rows = records.map((rec, i) => {
    const row = {
      row: i + 2, // +1 for the header line, +1 because people count from 1
      name: String(rec[nameKey] ?? '').trim(),
      rawNumber: String(rec[numberKey] ?? '').trim(),
      number: null,
      display: null,
      status: 'valid',
      reason: '',
    };

    const parsed = normaliseNumber(row.rawNumber);
    if (parsed) {
      row.number = parsed.number;
      row.display = parsed.display;
    }

    if (!row.rawNumber) {
      row.status = 'invalid';
      row.reason = 'Missing number';
    } else if (!parsed) {
      row.status = 'invalid';
      row.reason = 'Not a valid phone number';
    } else if (!row.name) {
      row.status = 'invalid';
      row.reason = 'Missing name';
    } else if (seen.has(parsed.number)) {
      row.status = 'duplicate';
      row.reason = `Same number as row ${seen.get(parsed.number)}`;
    } else {
      seen.set(parsed.number, row.row);
    }
    return row;
  });

  const count = (s) => rows.filter((r) => r.status === s).length;
  return {
    rows,
    summary: {
      total: rows.length,
      valid: count('valid'),
      invalid: count('invalid'),
      duplicate: count('duplicate'),
    },
  };
}
