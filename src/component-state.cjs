function detectedCarCount(value) {
  if (Array.isArray(value)) return value.length;
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
}

function isOccupied(component) {
  return detectedCarCount(component?.detectedCars) > 0;
}

module.exports = { detectedCarCount, isOccupied };
