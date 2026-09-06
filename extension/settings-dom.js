// SPDX-License-Identifier: GPL-3.0-or-later
export function reorderSettingsRows(container, ordered) {
  if (ordered.length === container.children.length && ordered.every((row, index) => container.children[index] === row)) return;
  const focused = ordered.find(row => row.contains(container.ownerDocument.activeElement));
  const focusIndex = ordered.indexOf(focused);
  ordered.forEach((row, index) => {
    if (focused && index < focusIndex) focused.before(row);
    else if (row !== focused) container.append(row);
  });
}
