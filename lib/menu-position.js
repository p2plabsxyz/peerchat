// Where a menu opened at the pointer goes so all of it stays in the window:
// below and to the right of the pointer when it fits, above or to the left of
// it when it does not, and never past an edge. A chat at the bottom of the
// list opened its menu below the window, with the last options cut off.
export function menuPosition({ x, y, width, height, viewportWidth, viewportHeight, margin = 8 }) {
  const left = x + width + margin > viewportWidth ? x - width : x;
  const top = y + height + margin > viewportHeight ? y - height : y;
  return {
    left: clamp(left, margin, viewportWidth - width - margin),
    top: clamp(top, margin, viewportHeight - height - margin),
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}
