import { ApiError } from './errors.js';

function units(value: string): bigint {
  if (!/^(0|[1-9]\d{0,12})(\.\d{1,6})?$/.test(value)) throw new ApiError(502, 'INVALID_SUPPLIER_PRICE', 'The supplier did not return a valid price.');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}
export function requireBudget(amount: string, currency: string, max: { amount: string; currency: string }) {
  if (currency !== max.currency) throw new ApiError(409, 'CURRENCY_CHANGED', 'The quote currency does not match max_total.');
  if (units(amount) > units(max.amount)) throw new ApiError(409, 'PRICE_OVER_BUDGET', 'The current price exceeds max_total.', { current: { amount, currency } });
}
