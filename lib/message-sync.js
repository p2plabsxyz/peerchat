// Whether the periodic sync check has found something the message pane is not
// showing, and should therefore rebuild it.
//
// Rebuilding replaces every element in the pane, so an image is thrown away and
// fetched again each time. The check used to compare the raw history length
// against the buffer, and the buffer has reactions and empty entries taken out
// of it, so any room with a single reaction in it looked permanently behind and
// rebuilt itself every two seconds. On screen that is a picture that blinks
// forever.
export function shouldRerenderMessages({
  freshCount,
  bufferedCount,
  domCount,
  searching = false,
}) {
  // Both sides counted the same way: what would actually be drawn.
  if (freshCount > bufferedCount) return true;
  // A search is showing a subset on purpose, so a short pane is not a gap.
  if (searching) return false;
  return bufferedCount > 0 && domCount < bufferedCount;
}
