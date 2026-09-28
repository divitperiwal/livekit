/**
 * Masking personal data in what is stored, for organisations that opt in.
 *
 * Applied on write, to transcript turns and summaries, so the unmasked text
 * never reaches the database, its backups or its replicas -- which is what
 * the DPDP Act's data-minimisation principle asks for, and what redacting on
 * read would not give.
 *
 * What it catches: email addresses, Indian and international phone numbers,
 * card numbers (checked with Luhn, so an order number is not mistaken for
 * one), Aadhaar numbers and PAN. What it cannot: numbers spoken as words
 * ("nine eight seven six…"), which is how speech-to-text sometimes writes
 * them, and names or addresses, which no pattern recognises reliably. It is a
 * reduction in what is kept, not a guarantee that nothing is.
 *
 * Structured analysis fields are left alone: a business that asks for the
 * callback number wants the callback number.
 */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PAN = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g;
// Runs of digits with the separators people and transcribers use.
const DIGIT_RUN = /\+?\d(?:[\d\s().-]{5,}\d)/g;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * One run of digits, classified whole. Classifying the run rather than
 * matching each pattern separately matters: an Aadhaar pattern run over text
 * first would take the first twelve digits of a card number and leave the
 * rest behind.
 */
function maskDigits(run: string): string {
  const digits = run.replace(/\D/g, "");
  if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return "[card]";
  // Aadhaar: twelve digits, never starting 0 or 1 -- unless it reads as a
  // phone number, 91 and then a mobile, or was written with a "+".
  if (digits.length === 12 && /^[2-9]/.test(digits) && !run.startsWith("+") && !/^91[6-9]/.test(digits)) {
    return "[aadhaar]";
  }
  // Ten or more digits is a phone number in any country that matters here;
  // shorter runs are amounts, times and order numbers, and are left alone.
  if (digits.length >= 10 && digits.length <= 15) return "[phone]";
  return run;
}

export function redact(text: string): string {
  return text
    .replace(EMAIL, "[email]")
    .replace(PAN, "[pan]")
    .replace(DIGIT_RUN, maskDigits);
}
