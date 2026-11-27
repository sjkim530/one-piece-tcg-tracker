/* OpenCV and catalog feature matching run off the UI thread. */
'use strict';
const OPENCV_URL = 'https://docs.opencv.org/4.12.0/opencv.js';
let runtimePromise, indexPromise, indexUrlLoaded;
const cancelled = new Set();
const active = new Map(), slots = {};
let model;

function loadRuntime() {
  if (!runtimePromise) runtimePromise = new Promise((resolve, reject) => {
    let timer;
    const deadline = setTimeout(() => { clearInterval(timer); reject(new Error('Image-processing download timed out')); }, 40000);
    try {
      importScripts(OPENCV_URL);
      // This pinned build is a self-resolving thenable, not a normal Promise.
      // Test its initialized API instead of awaiting cv itself.
      timer = setInterval(() => {
        if (self.cv?.Mat && self.cv?.ORB) { clearInterval(timer); clearTimeout(deadline); resolve(true); }
      }, 25);
    } catch (error) { clearTimeout(deadline); reject(error); }
  }).catch(error => { runtimePromise = null; throw error; });
  return runtimePromise;
}

function parseIndex(manifest, buffer) {
  if (manifest.version !== 1 || manifest.descriptorBytes !== 32 || manifest.recordBytes !== 36 || !Array.isArray(manifest.cards)) {
    throw new Error('Unsupported visual index. Reload the app for the matching version.');
  }
  if (buffer.byteLength > 64 * 1024 * 1024 || buffer.byteLength % 36 || (manifest.byteLength != null && manifest.byteLength !== buffer.byteLength)) throw new Error('Visual index is incomplete or too large');
  const total = buffer.byteLength / 36;
  if (manifest.cards.length > 15000) throw new Error('Visual index has too many entries');
  const owners = new Uint16Array(total), bytes = new Uint8Array(buffer), view = new DataView(buffer);
  let cursor = 0;
  const ids = new Set();
  for (let i = 0; i < manifest.cards.length; i++) {
    const card = manifest.cards[i], offset = card.offset ?? card.start;
    if (!Number.isInteger(offset) || !Number.isInteger(card.count) || offset !== cursor || card.count < 1 || card.count > 512 || offset + card.count > total ||
        !card.id || ids.has(String(card.id)) || !(card.width > 0 && card.height > 0)) {
      throw new Error('Visual index contains an invalid entry');
    }
    card.offset = offset;
    ids.add(String(card.id)); cursor += card.count;
    owners.fill(i, offset, offset + card.count);
  }
  if (cursor !== total) throw new Error('Visual index contains unassigned features');
  return { manifest, bytes, view, owners, total, tables: [] };
}

function hash(bytes, feature, table) {
  const at = feature * 36 + table * 4;
  return (bytes[at] << 8) | bytes[at + 1];
}

async function buildTables(index) {
  for (let table = 0; table < 8; table++) {
    const offsets = new Uint32Array(65537);
    for (let feature = 0; feature < index.total; feature++) offsets[hash(index.bytes, feature, table) + 1]++;
    for (let i = 1; i < offsets.length; i++) offsets[i] += offsets[i - 1];
    const cursors = offsets.slice(), entries = new Uint32Array(index.total);
    for (let feature = 0; feature < index.total; feature++) entries[cursors[hash(index.bytes, feature, table)]++] = feature;
    index.tables.push({ offsets, entries });
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

async function fetchChecked(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error('Could not download visual data (' + response.status + ')');
  return response;
}

function loadIndex(url) {
  if (indexPromise && indexUrlLoaded === url) return indexPromise;
  indexUrlLoaded = url;
  indexPromise = (async () => {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 70000);
    try {
      const manifest = await (await fetchChecked(url, controller.signal)).json();
      if (!manifest.binary) throw new Error('Visual index filename is missing');
      const binaryUrl = new URL(manifest.binary, url);
      if (binaryUrl.origin !== new URL(url).origin) throw new Error('Visual data must come from this app');
      const buffer = await (await fetchChecked(binaryUrl.href, controller.signal)).arrayBuffer();
      if (manifest.sha256 && self.crypto?.subtle) {
        const digest = await crypto.subtle.digest('SHA-256', buffer);
        const actual = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
        if (actual !== manifest.sha256) throw new Error('Visual index verification failed');
      }
      const next = parseIndex(manifest, buffer);
      await buildTables(next); model = next;
      return next;
    } finally { clearTimeout(timer); }
  })().catch(error => { indexPromise = null; throw error; });
  return indexPromise;
}

function grayImage(image) {
  if (!image.width || !image.height || image.buffer.byteLength !== image.width * image.height * 4) throw new Error('Invalid camera image');
  const rgba = cv.matFromArray(image.height, image.width, cv.CV_8UC4, new Uint8Array(image.buffer)), gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY); rgba.delete();
  return gray;
}

function polygonArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) { const a = points[i], b = points[(i + 1) % points.length]; sum += a.x * b.y - a.y * b.x; }
  return Math.abs(sum / 2);
}

function rotatedPoints(rect) {
  const angle = rect.angle * Math.PI / 180, cosine = Math.cos(angle), sine = Math.sin(angle);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => ({
    x: rect.center.x + x * rect.size.width / 2 * cosine - y * rect.size.height / 2 * sine,
    y: rect.center.y + x * rect.size.width / 2 * sine + y * rect.size.height / 2 * cosine
  }));
}

function expandedCardShape(edges, image) {
  const closed = new cv.Mat(), hierarchy = new cv.Mat(), contours = new cv.MatVector();
  let best = null;
  try {
    for (const size of [3, 7]) {
      const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(size, size));
      try { cv.morphologyEx(edges, closed, cv.MORPH_CLOSE, kernel); }
      finally { kernel.delete(); }
      cv.findContours(closed, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      const large = [];
      for (let i = 0; i < contours.size(); i++) {
        const contour = contours.get(i);
        try { const rect = cv.boundingRect(contour); if (rect.width * rect.height > image.width * image.height * .13) large.push({ i, area: rect.width * rect.height }); }
        finally { contour.delete(); }
      }
      for (const item of large.sort((a, b) => b.area - a.area).slice(0, 20)) {
        const contour = contours.get(item.i), hull = new cv.Mat();
        try {
          cv.convexHull(contour, hull);
          const rect = cv.minAreaRect(hull), width = rect.size.width, height = rect.size.height;
          const ratio = Math.min(width, height) / Math.max(width, height), area = width * height / (image.width * image.height);
          const fill = cv.contourArea(hull) / Math.max(1, width * height), points = rotatedPoints(rect);
          if (ratio < .6 || ratio > .82 || area < .15 || area > .94 || fill < .76 ||
              points.some(point => point.x < -image.width * .04 || point.x > image.width * 1.04 || point.y < -image.height * .04 || point.y > image.height * 1.04)) continue;
          if (!best || area * fill > best.area * best.fill) best = { points, area, fill };
        } finally { contour.delete(); hull.delete(); }
      }
    }
    return best;
  } finally { for (const object of [closed, hierarchy, contours]) object.delete(); }
}

function lineCardShape(edges, image) {
  const lines = new cv.Mat();
  try {
    cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 35, Math.max(image.width, image.height) * .16, 22);
    const horizontal = [], vertical = [];
    for (let n = 0; n < lines.rows; n++) {
      const at = n * 4, line = { x0: lines.data32S[at], y0: lines.data32S[at + 1], x1: lines.data32S[at + 2], y1: lines.data32S[at + 3] };
      line.length = Math.hypot(line.x1 - line.x0, line.y1 - line.y0);
      if (Math.abs(line.x1 - line.x0) > Math.abs(line.y1 - line.y0) * 3) horizontal.push(line);
      if (Math.abs(line.y1 - line.y0) > Math.abs(line.x1 - line.x0) * 3) vertical.push(line);
    }
    const h = horizontal.sort((a, b) => b.length - a.length).slice(0, 12), v = vertical.sort((a, b) => b.length - a.length).slice(0, 12);
    const intersect = (a, b) => {
      const dx = a.x1 - a.x0, dy = a.y1 - a.y0, ex = b.x1 - b.x0, ey = b.y1 - b.y0;
      const denominator = dx * ey - dy * ex;
      if (Math.abs(denominator) < 1) return null;
      const t = ((b.x0 - a.x0) * ey - (b.y0 - a.y0) * ex) / denominator;
      return { x: a.x0 + t * dx, y: a.y0 + t * dy };
    };
    let best = null;
    for (let a = 0; a < v.length; a++) for (let b = a + 1; b < v.length; b++) for (const top of h) {
      const left = intersect(top, v[a]), right = intersect(top, v[b]);
      if (!left || !right) continue;
      const width = Math.hypot(right.x - left.x, right.y - left.y), height = width * 1.4;
      if (width < image.width * .25 || Math.min(v[a].length, v[b].length) < height * .5 || top.length < width * .45) continue;
      const slopeA = (v[a].x1 - v[a].x0) / (v[a].y1 - v[a].y0), slopeB = (v[b].x1 - v[b].x0) / (v[b].y1 - v[b].y0);
      if (Math.abs(slopeA - slopeB) > .15) continue;
      const centerY = (v[a].y0 + v[a].y1 + v[b].y0 + v[b].y1) / 4;
      const direction = (left.y + right.y) / 2 < centerY ? 1 : -1;
      const dy = direction * height / Math.sqrt(1 + ((slopeA + slopeB) / 2) ** 2), dx = dy * (slopeA + slopeB) / 2;
      const points = [left, right, { x: right.x + dx, y: right.y + dy }, { x: left.x + dx, y: left.y + dy }];
      const area = polygonArea(points) / (image.width * image.height);
      if (area < .15 || area > .92 || points.some(point => point.x < -image.width * .03 || point.x > image.width * 1.03 || point.y < -image.height * .03 || point.y > image.height * 1.03)) continue;
      if (!best || area > best.area) best = { points, area };
    }
    return best;
  } finally { lines.delete(); }
}

function foregroundSeparation(image, quad) {
  if (!quad) return 0;
  const pixels = new Uint8Array(image.buffer), inside = new Uint32Array(64), outside = new Uint32Array(64);
  let countIn = 0, countOut = 0;
  for (let y = 2; y < image.height; y += 4) for (let x = 2; x < image.width; x += 4) {
    let positive = true, negative = true;
    for (let n = 0; n < 4; n++) {
      const a = quad[n], b = quad[(n + 1) % 4];
      const cross = (b.x - a.x) * (y / image.height - a.y) - (b.y - a.y) * (x / image.width - a.x);
      positive = positive && cross >= 0; negative = negative && cross <= 0;
    }
    const at = (y * image.width + x) * 4, bucket = ((pixels[at] >> 6) << 4) | ((pixels[at + 1] >> 6) << 2) | (pixels[at + 2] >> 6);
    if (positive || negative) { inside[bucket]++; countIn++; } else { outside[bucket]++; countOut++; }
  }
  if (!countIn || !countOut) return 0;
  let distance = 0;
  for (let n = 0; n < 64; n++) distance += Math.abs(inside[n] / countIn - outside[n] / countOut);
  return distance / 2;
}

function analyzeImage(image) {
  const gray = grayImage(image), blur = new cv.Mat(), edges = new cv.Mat(), hierarchy = new cv.Mat();
  const contours = new cv.MatVector(), lap = new cv.Mat(), mean = new cv.Mat(), deviation = new cv.Mat();
  let quad = null, coverage = 0, sharpness = 0, brightness = 0;
  try {
    brightness = cv.mean(gray)[0];
    cv.Laplacian(gray, lap, cv.CV_64F); cv.meanStdDev(lap, mean, deviation);
    sharpness = deviation.data64F[0] ** 2;
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0); cv.Canny(blur, edges, 45, 130);
    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i), approx = new cv.Mat();
      try {
        cv.approxPolyDP(contour, approx, cv.arcLength(contour, true) * .025, true);
        if (approx.rows !== 4 || !cv.isContourConvex(approx)) continue;
        const points = Array.from({ length: 4 }, (_, n) => ({ x: approx.data32S[n * 2], y: approx.data32S[n * 2 + 1] }));
        const area = polygonArea(points) / (image.width * image.height);
        if (area < .1 || area > .98 || area <= coverage) continue;
        const sides = points.map((point, n) => Math.hypot(point.x - points[(n + 1) % 4].x, point.y - points[(n + 1) % 4].y));
        const a = (sides[0] + sides[2]) / 2, b = (sides[1] + sides[3]) / 2, ratio = Math.min(a, b) / Math.max(a, b);
        if (ratio < .52 || ratio > .9) continue;
        quad = points.map(point => ({ x: point.x / image.width, y: point.y / image.height })); coverage = area;
      } finally { contour.delete(); approx.delete(); }
    }
    const expanded = expandedCardShape(edges, image);
    if (expanded && expanded.area > coverage) {
      quad = expanded.points.map(point => ({ x: point.x / image.width, y: point.y / image.height })); coverage = expanded.area;
    }
    const lined = lineCardShape(edges, image);
    if (lined && lined.area > coverage) {
      quad = lined.points.map(point => ({ x: point.x / image.width, y: point.y / image.height })); coverage = lined.area;
    }
    if (quad) {
      const region = cv.Mat.zeros(image.height, image.width, cv.CV_8U);
      const polygon = cv.matFromArray(4, 1, cv.CV_32SC2, quad.flatMap(point => [Math.round(point.x * image.width), Math.round(point.y * image.height)]));
      const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9));
      try {
        cv.fillConvexPoly(region, polygon, new cv.Scalar(255)); cv.erode(region, region, kernel);
        cv.meanStdDev(lap, mean, deviation, region); sharpness = deviation.data64F[0] ** 2;
        brightness = cv.mean(gray, region)[0];
      } finally { region.delete(); polygon.delete(); kernel.delete(); }
    }
    const separation = foregroundSeparation(image, quad);
    const usable = brightness > 25 && brightness < 245 && sharpness > 30 && !!quad && separation >= .1;
    const reason = brightness <= 25 ? 'dark' : brightness >= 245 ? 'bright' : sharpness <= 30 ? 'blur' : quad && separation >= .1 ? 'card-framed' : 'no-card-shape';
    const message = reason === 'dark' ? 'Add light so the artwork is visible' : reason === 'bright' ? 'Reduce bright reflections'
      : reason === 'blur' ? 'Let the camera focus on the card' : reason === 'card-framed' ? 'Card in view. Checking artwork…' : 'Keep one whole card visible against a clear background.';
    return { ready: usable, quality: usable ? Math.min(1, .45 + Math.min(sharpness / 1000, .3) + (quad ? .25 : 0)) : 0,
      reason, message, quad, coverage, sharpness, brightness, separation };
  } finally { for (const object of [gray, blur, edges, hierarchy, contours, lap, mean, deviation]) object.delete(); }
}

const bitCount = Uint8Array.from({ length: 256 }, (_, n) => { let count = 0; for (; n; n &= n - 1) count++; return count; });
function descriptorDistance(query, at, bytes, feature) {
  let distance = 0;
  for (let n = 0; n < 32; n++) distance += bitCount[query[at + n] ^ bytes[feature * 36 + n]];
  return distance;
}

function shortlist(descriptors, index, limit = 48) {
  const votes = new Uint32Array(index.manifest.cards.length), stamp = new Uint16Array(votes.length), bestDistance = new Uint8Array(votes.length);
  for (let query = 0; query < descriptors.rows; query++) {
    const marker = query + 1;
    for (let table = 0; table < 8; table++) {
      const at = query * 32 + table * 4, bucket = (descriptors.data[at] << 8) | descriptors.data[at + 1];
      const { offsets, entries } = index.tables[table], start = offsets[bucket], end = offsets[bucket + 1];
      if (end - start > 4000) continue;
      for (let n = start; n < end; n++) {
        const feature = entries[n], distance = descriptorDistance(descriptors.data, query * 32, index.bytes, feature);
        if (distance > 64) continue;
        const card = index.owners[feature];
        if (stamp[card] !== marker) {
          stamp[card] = marker; bestDistance[card] = distance; votes[card] += 72 - distance;
        } else if (distance < bestDistance[card]) {
          votes[card] += bestDistance[card] - distance; bestDistance[card] = distance;
        }
      }
    }
  }
  return [...votes].map((vote, card) => ({ vote, card })).filter(item => item.vote >= 2)
    .sort((a, b) => b.vote - a.vote).slice(0, limit);
}

function projectedCard(homography, card, width, height) {
  const h = homography.data64F;
  if (h.length !== 9 || [...h].some(value => !Number.isFinite(value))) return null;
  const points = [[0, 0], [card.width, 0], [card.width, card.height], [0, card.height]].map(([x, y]) => {
    const divisor = h[6] * x + h[7] * y + h[8];
    return { x: (h[0] * x + h[1] * y + h[2]) / divisor, y: (h[3] * x + h[4] * y + h[5]) / divisor };
  });
  if (points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < -width * .15 || point.x > width * 1.15 || point.y < -height * .15 || point.y > height * 1.15)) return null;
  const cross = points.map((p, n) => {
    const a = points[(n + 1) % 4], b = points[(n + 2) % 4];
    return (a.x - p.x) * (b.y - a.y) - (a.y - p.y) * (b.x - a.x);
  });
  if (!cross.every(value => value > 0) && !cross.every(value => value < 0)) return null;
  const area = polygonArea(points) / (width * height);
  if (area < .06 || area > 1.1) return null;
  const sides = points.map((p, n) => Math.hypot(p.x - points[(n + 1) % 4].x, p.y - points[(n + 1) % 4].y));
  if (Math.max(...sides) / Math.min(...sides) > 3.2 || Math.max(sides[0], sides[2]) / Math.min(sides[0], sides[2]) > 2 || Math.max(sides[1], sides[3]) / Math.min(sides[1], sides[3]) > 2) return null;
  return points.map(point => ({ x: point.x / width, y: point.y / height }));
}

function verifyCard(query, keypoints, card, index, width, height) {
  if (card.count < 6) return null;
  const reference = new cv.Mat(card.count, 32, cv.CV_8U), matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);
  const pairs = new cv.DMatchVectorVector(), source = [], destination = [], used = new Set();
  let src, dst, mask, homography;
  try {
    for (let n = 0; n < card.count; n++) reference.data.set(index.bytes.subarray((card.offset + n) * 36, (card.offset + n) * 36 + 32), n * 32);
    matcher.knnMatch(reference, query, pairs, 4);
    for (let n = 0; n < pairs.size(); n++) {
      const pair = pairs.get(n);
      try {
        if (pair.size() < 2) continue;
        const first = pair.get(0), point = keypoints.get(first.trainIdx).pt;
        let second = pair.get(1);
        // ORB can report the same physical corner at neighboring pyramid
        // levels. Compare against a different corner, not that duplicate.
        for (let k = 1; k < pair.size(); k++) {
          const option = pair.get(k), next = keypoints.get(option.trainIdx).pt;
          second = option;
          if (Math.hypot(next.x - point.x, next.y - point.y) > 5) break;
        }
        if (first.distance > 80 || first.distance >= second.distance * .85 || used.has(first.trainIdx)) continue;
        used.add(first.trainIdx);
        const at = (card.offset + first.queryIdx) * 36;
        source.push(index.view.getUint16(at + 32, true) / 65535 * card.width, index.view.getUint16(at + 34, true) / 65535 * card.height);
        destination.push(point.x, point.y);
      } finally { pair.delete(); }
    }
    if (source.length < 12) return null;
    src = cv.matFromArray(source.length / 2, 1, cv.CV_32FC2, source);
    dst = cv.matFromArray(destination.length / 2, 1, cv.CV_32FC2, destination);
    mask = new cv.Mat(); homography = cv.findHomography(src, dst, cv.RANSAC, 4, mask, 1500, .995);
    if (homography.empty()) return null;
    const quad = projectedCard(homography, card, width, height);
    if (!quad) return null;
    let inliers = 0, artInliers = 0; const xs = [], ys = [];
    for (let n = 0; n < mask.rows; n++) if (mask.data[n]) {
      const x = source[n * 2] / card.width, y = source[n * 2 + 1] / card.height;
      inliers++; xs.push(x); ys.push(y);
      if (x > .12 && x < .88 && y > .1 && y < .67) artInliers++;
    }
    if (inliers < 6 || artInliers < 2) return null;
    const coverage = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    const ratio = inliers / (source.length / 2);
    const score = inliers + artInliers * 2 + coverage * 10;
    return { id: String(card.id), aliases: card.aliases, score, inliers, artInliers, matches: source.length / 2, coverage, ratio, quad };
  } finally {
    for (const object of [reference, matcher, pairs, src, dst, mask, homography]) object?.delete();
  }
}

function matchingResult(ranked) {
  const reliable = ranked.filter(item => item.inliers >= 8 && item.artInliers >= 3 && item.coverage >= .12 && item.ratio >= .35)
    .sort((a, b) => b.score - a.score);
  const best = reliable[0], confident = !!best;
  const candidates = best ? reliable.filter(item => item.score >= best.score * .72).slice(0, 8) : [];
  const expanded = [];
  for (const candidate of candidates) for (const product of [candidate.id, ...(candidate.aliases || [])]) {
    if (!expanded.some(item => item.id === String(product))) expanded.push({ ...candidate, id: String(product) });
  }
  return { visual: true, confident, candidates: expanded, totalCandidates: expanded.length, numbers: [], readNumbers: [], starred: null, name: null,
    reason: confident ? expanded.length === 1 ? 'artwork-matched' : 'similar-printings' : 'no-reliable-match' };
}

async function matchView(image, index, id) {
  const gray = grayImage(image), keypoints = new cv.KeyPointVector(), descriptors = new cv.Mat(), mask = new cv.Mat();
  const orb = new cv.ORB(1200, 1.2, 8, 15, 0, 2, cv.ORB_HARRIS_SCORE, 31, 12);
  try {
    orb.detectAndCompute(gray, mask, keypoints, descriptors);
    const ranked = [];
    for (const candidate of shortlist(descriptors, index)) {
      if (cancelled.has(id)) throw new Error('Scan cancelled');
      const result = verifyCard(descriptors, keypoints, index.manifest.cards[candidate.card], index, image.width, image.height);
      if (result) ranked.push(result);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return matchingResult(ranked);
  } finally { for (const object of [gray, keypoints, descriptors, mask, orb]) object.delete(); }
}

function portraitQuad(points) {
  const center = points.reduce((sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }), { x: 0, y: 0 });
  const ordered = points.slice().sort((a, b) => Math.atan2(a.y - center.y, a.x - center.x) - Math.atan2(b.y - center.y, b.x - center.x));
  const start = ordered.reduce((best, point, i) => point.x + point.y < ordered[best].x + ordered[best].y ? i : best, 0);
  const result = ordered.slice(start).concat(ordered.slice(0, start));
  const length = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  if (length(result[0], result[1]) > length(result[1], result[2])) result.push(result.shift());
  return result;
}

async function matchImage(image, index, id) {
  const first = await matchView(image, index, id);
  if (first.confident || cancelled.has(id)) return first;
  // One bounded second view normalizes perspective and scale to the catalog.
  // Keep the whole-frame result first: a rough shape proposal can include
  // surrounding objects, and must never replace an already verified match.
  const rgba = cv.matFromArray(image.height, image.width, cv.CV_8UC4, new Uint8Array(image.buffer)), small = new cv.Mat();
  let source, target, transform, rectified;
  try {
    const scale = Math.min(1, 640 / Math.max(image.width, image.height));
    cv.resize(rgba, small, new cv.Size(Math.round(image.width * scale), Math.round(image.height * scale)), 0, 0, cv.INTER_AREA);
    const quality = analyzeImage({ width: small.cols, height: small.rows, buffer: small.data.slice().buffer });
    if (!quality.ready || !quality.quad || cancelled.has(id)) return first;
    const points = portraitQuad(quality.quad.map(point => ({ x: point.x * image.width, y: point.y * image.height })));
    source = cv.matFromArray(4, 1, cv.CV_32FC2, points.flatMap(point => [point.x, point.y]));
    target = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, 300, 0, 300, 419, 0, 419]);
    transform = cv.getPerspectiveTransform(source, target); rectified = new cv.Mat();
    cv.warpPerspective(rgba, rectified, transform, new cv.Size(301, 420));
    const second = await matchView({ width: 301, height: 420, buffer: rectified.data.slice().buffer }, index, id);
    if (!second.confident) return first;
    // These homographies were checked in rectified coordinates; do not expose
    // them as if they were positions in the original camera frame.
    second.candidates = second.candidates.map(({ quad, ...candidate }) => candidate);
    return { ...second, matchedFrame: 'rectified-card' };
  } finally { for (const object of [rgba, small, source, target, transform, rectified]) object?.delete(); }
}

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  if (type === 'cancel') {
    if (active.has(id)) { cancelled.add(id); const kind = active.get(id); if (slots[kind] === id) delete slots[kind]; }
    return;
  }
  if ((type === 'analyze' || type === 'match') && slots[type] != null) {
    self.postMessage({ id, error: 'Visual scanner is busy. Please retry shortly.' }); return;
  }
  active.set(id, type);
  if (type === 'analyze' || type === 'match') slots[type] = id;
  const progress = stage => { if (!cancelled.has(id)) self.postMessage({ id, progress: stage }); };
  try {
    progress('runtime');
    await loadRuntime();
    if (cancelled.has(id)) return;
    let result;
    if (type === 'analyze') result = analyzeImage(data.image);
    else if (type === 'init' || type === 'match') {
      progress('index'); const index = await loadIndex(data.indexUrl);
      if (cancelled.has(id)) return;
      result = type === 'init' ? { cards: index.manifest.cards.length, indexVersion: index.manifest.version }
        : await matchImage(data.image, index, id);
      progress('ready');
    } else throw new Error('Unknown visual scanner operation');
    if (!cancelled.has(id)) self.postMessage({ id, result });
  } catch (error) { if (!cancelled.has(id)) self.postMessage({ id, error: String(error.message || error) }); }
  finally { cancelled.delete(id); active.delete(id); if (slots[type] === id) delete slots[type]; }
};
