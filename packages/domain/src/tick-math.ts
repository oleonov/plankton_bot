export function roundToTick(price: number, tickSize: number): number {
  if (!Number.isFinite(price)) return price;
  if (!Number.isFinite(tickSize) || tickSize <= 0) return price;
  const rounded = Math.round(price / tickSize) * tickSize;
  return Number(rounded.toFixed(decimalPlaces(tickSize) + 2));
}

function decimalPlaces(value: number): number {
  const text = value.toString().toLowerCase();
  const exponentIndex = text.indexOf("e-");
  if (exponentIndex >= 0) return Number(text.slice(exponentIndex + 2)) || 0;
  const dotIndex = text.indexOf(".");
  return dotIndex >= 0 ? text.length - dotIndex - 1 : 0;
}
