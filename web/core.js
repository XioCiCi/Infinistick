export const STEP = 430;
const LEFT = 200, RIGHT = 3210, RADIUS = 380, STRAIGHT = RIGHT - LEFT;

export function sortedRecords(records, topicId, committedTimes = new Map()) {
  return records.filter(r => r.topicId === topicId && !r.deleted).sort((a, b) =>
    Date.parse(committedTimes.get(a.id) || a.time) - Date.parse(committedTimes.get(b.id) || b.time) || a.seq - b.seq);
}

export function timeline(count) {
  const points = [];
  const cycle = STRAIGHT + Math.PI * RADIUS;
  const endDistance = Math.max(0, count - 1) * STEP;
  const lastRow = Math.floor(endDistance / cycle);
  let path = `M ${LEFT} 300`;
  for (let row = 0; row <= lastRow; row++) {
    const y = 300 + row * RADIUS * 2;
    const rightward = row % 2 === 0;
    const endX = rightward ? RIGHT : LEFT;
    const rowDistance = endDistance - row * cycle;
    if (row === lastRow && rowDistance <= STRAIGHT) {
      const x = (rightward ? LEFT : RIGHT) + (rightward ? 1 : -1) * Math.min(STRAIGHT, rowDistance + 180);
      path += ` L ${x} ${y}`;
    } else {
      path += ` L ${endX} ${y} A ${RADIUS} ${RADIUS} 0 0 ${rightward ? 1 : 0} ${endX} ${y + RADIUS * 2}`;
    }
  }
  for (let index = 0; index < count; index++) {
    const distance = index * STEP, row = Math.floor(distance / cycle), local = distance - row * cycle;
    const y = 300 + row * RADIUS * 2, rightward = row % 2 === 0;
    let point;
    if (local <= STRAIGHT) {
      point = {x: (rightward ? LEFT : RIGHT) + (rightward ? local : -local), y};
    } else {
      const angle = (local - STRAIGHT) / RADIUS;
      point = {x: (rightward ? RIGHT : LEFT) + (rightward ? 1 : -1) * RADIUS * Math.sin(angle),
               y: y + RADIUS * (1 - Math.cos(angle))};
    }
    points.push({...point, index});
  }
  return {points, path};
}

export function summaryPosition(point) {
  return {x: point.x - 130, y: point.y + (point.index % 2 ? 45 : -220)};
}

export function fitBounds(rects, width, height, padding = 70) {
  if (!rects.length) return {x: width / 2 - 200, y: height / 2 - 300, scale: 1};
  const minX = Math.min(...rects.map(r => r.x)), minY = Math.min(...rects.map(r => r.y));
  const maxX = Math.max(...rects.map(r => r.x + r.width)), maxY = Math.max(...rects.map(r => r.y + r.height));
  const scale = Math.max(.025, Math.min(1, (width - padding * 2) / (maxX - minX || 1), (height - padding * 2) / (maxY - minY || 1)));
  return {scale, x: (width - (maxX - minX) * scale) / 2 - minX * scale,
          y: (height - (maxY - minY) * scale) / 2 - minY * scale};
}

export function zoomAt(view, nextScale, x, y) {
  const scale = Math.max(.025, Math.min(2.5, nextScale)), ratio = scale / view.scale;
  return {scale, x: x - (x - view.x) * ratio, y: y - (y - view.y) * ratio};
}

export function localInput(iso = new Date().toISOString()) {
  const date = new Date(iso);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

export function isoFromInput(value) {
  const parsed = new Date(value);
  if (!value || !Number.isFinite(parsed.getTime())) throw new Error('请选择有效的日期和时间');
  return parsed.toISOString();
}

export function afterBlankClick({editing, pinned, saved}) {
  if (!saved) return {editing, expanded: true};
  return {editing: false, expanded: pinned};
}
