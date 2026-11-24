// Automatic field detection for a PDF page using pdf.js (v3).
// All output coordinates are in "top-left" page points (pdf.js viewport at scale 1).
(function (root) {
  var HEB = /[֐-׿]/;
  var BOX_GLYPHS = /[☐☑☒□▢◻◽❏❐❑❒]/;

  function mul(m, n) {
    return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  }
  function apply(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }

  // ---- vector segments from the operator list ----
  function segmentsFromOps(OPS, opList, vp) {
    var fn = opList.fnArray, ar = opList.argsArray;
    var ctm = vp.transform.slice(), stack = [], lw = 1;
    var pending = [], segs = [];
    function P(x, y) { return apply(ctm, x, y); }
    function addRect(x, y, w, h, mode) {
      var a = P(x, y), b = P(x + w, y + h);
      var x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
      pending.push({ k: "rect", x0: x0, x1: x1, y0: y0, y1: y1 });
    }
    for (var i = 0; i < fn.length; i++) {
      var op = fn[i], a = ar[i];
      if (op === OPS.save) stack.push({ ctm: ctm.slice(), lw: lw });
      else if (op === OPS.restore) { var s = stack.pop(); if (s) { ctm = s.ctm; lw = s.lw; } }
      else if (op === OPS.transform) ctm = mul(ctm, a);
      else if (op === OPS.setLineWidth) lw = a[0];
      else if (op === OPS.constructPath) {
        var ops = a[0], args = a[1], j = 0, cur = null, start = null;
        for (var k = 0; k < ops.length; k++) {
          var o = ops[k];
          if (o === OPS.rectangle) { addRect(args[j], args[j + 1], args[j + 2], args[j + 3]); j += 4; }
          else if (o === OPS.moveTo) { cur = P(args[j], args[j + 1]); start = cur; j += 2; }
          else if (o === OPS.lineTo) { var nx = P(args[j], args[j + 1]); if (cur) pending.push({ k: "line", a: cur, b: nx }); cur = nx; j += 2; }
          else if (o === OPS.curveTo) { cur = P(args[j + 4], args[j + 5]); j += 6; pending.push({ k: "curve" }); }
          else if (o === OPS.curveTo2 || o === OPS.curveTo3) { cur = P(args[j + 2], args[j + 3]); j += 4; pending.push({ k: "curve" }); }
          else if (o === OPS.closePath) { if (cur && start) pending.push({ k: "line", a: cur, b: start }); cur = start; }
        }
      }
      else if (op === OPS.endPath) pending = [];
      else if (op === OPS.fill || op === OPS.eoFill || op === OPS.stroke || op === OPS.closeStroke ||
               op === OPS.fillStroke || op === OPS.eoFillStroke || op === OPS.closeFillStroke || op === OPS.closeEOFillStroke) {
        var stroke = op !== OPS.fill && op !== OPS.eoFill;
        var hasCurve = pending.some(function (p) { return p.k === "curve"; });
        if (!hasCurve) pending.forEach(function (p) {
          if (p.k === "rect") {
            var w = p.x1 - p.x0, h = p.y1 - p.y0;
            if (h < 2 && w > 2) segs.push({ o: "h", y: (p.y0 + p.y1) / 2, x0: p.x0, x1: p.x1 });
            else if (w < 2 && h > 2) segs.push({ o: "v", x: (p.x0 + p.x1) / 2, y0: p.y0, y1: p.y1 });
            else if (stroke && w > 2 && h > 2) {
              segs.push({ o: "h", y: p.y0, x0: p.x0, x1: p.x1 }, { o: "h", y: p.y1, x0: p.x0, x1: p.x1 },
                        { o: "v", x: p.x0, y0: p.y0, y1: p.y1 }, { o: "v", x: p.x1, y0: p.y0, y1: p.y1 });
            }
          } else if (p.k === "line" && stroke) {
            if (Math.abs(p.a[1] - p.b[1]) < 1) segs.push({ o: "h", y: p.a[1], x0: Math.min(p.a[0], p.b[0]), x1: Math.max(p.a[0], p.b[0]) });
            else if (Math.abs(p.a[0] - p.b[0]) < 1) segs.push({ o: "v", x: p.a[0], y0: Math.min(p.a[1], p.b[1]), y1: Math.max(p.a[1], p.b[1]) });
          }
        });
        pending = [];
      }
    }
    return segs.filter(function (s) { return s.o === "h" ? s.x1 - s.x0 > 2 : s.y1 - s.y0 > 2; });
  }

  // merge collinear overlapping segments
  function merge(segs, o) {
    var L = segs.filter(function (s) { return s.o === o; }).map(function (s) { return Object.assign({}, s); });
    var key = o === "h" ? "y" : "x", a0 = o === "h" ? "x0" : "y0", a1 = o === "h" ? "x1" : "y1";
    L.sort(function (p, q) { return p[key] - q[key]; });
    var clusters = [], out = [];
    L.forEach(function (s) {
      var c = clusters[clusters.length - 1];
      if (c && Math.abs(c[c.length - 1][key] - s[key]) < 0.7) c.push(s); else clusters.push([s]);
    });
    clusters.forEach(function (c) {
      c.sort(function (p, q) { return p[a0] - q[a0]; });
      var m = null;
      c.forEach(function (s) {
        if (m && s[a0] <= m[a1] + 0.8) m[a1] = Math.max(m[a1], s[a1]);
        else { m = s; out.push(m); }
      });
    });
    return out;
  }

  // ---- text ----
  function textItems(tc, vp) {
    var items = [];
    tc.items.forEach(function (it) {
      if (!it.str || !it.str.trim()) return;
      var t = it.transform, fs = Math.hypot(t[2], t[3]) || it.height || 10;
      var p = vp.convertToViewportPoint(t[4], t[5]);
      var w = it.width, str = it.str, n = Array.from(str).length, cw = w / Math.max(1, n);
      // split on runs of 2+ spaces (separate phrases drawn as one item)
      var vis = it.dir === "rtl" ? Array.from(str).reverse().join("") : str;
      var re = /_{3,}|(?:[^\s_]|_(?!__))+(?:\s(?:[^\s_]|_(?!__))+)*/g, m;
      while ((m = re.exec(vis))) {
        var part = m[0], x0 = p[0] + cw * Array.from(vis.slice(0, m.index)).length, pw = cw * Array.from(part).length;
        var logical = it.dir === "rtl" ? Array.from(part).reverse().join("") : part;
        // pdf.js keeps mirrored bracket glyphs in RTL runs: swap to logical brackets
        if (it.dir === "rtl" && HEB.test(logical)) logical = logical.replace(/[()]/g, function (c) { return c === "(" ? ")" : "("; });
        items.push({ str: logical, dir: it.dir, x0: x0, x1: x0 + pw, base: p[1], top: p[1] - fs * 0.8, bottom: p[1] + fs * 0.22, fs: fs });
      }
    });
    return items;
  }

  function overlapX(a0, a1, b0, b1) { return Math.min(a1, b1) - Math.max(a0, b0); }

  function detectPage(OPS, opList, tc, vp, annots, pageIndex) {
    var segs = segmentsFromOps(OPS, opList, vp);
    var H = merge(segs, "h"), V = merge(segs, "v");
    var items = textItems(tc, vp);
    var heb = 0, lat = 0;
    items.forEach(function (it) { if (HEB.test(it.str)) heb += it.str.length; else lat += it.str.replace(/[^A-Za-z]/g, "").length; });
    var rtl = heb >= lat;
    var boxes = [], lines = [], cells = [];

    // -- AcroForm widgets
    (annots || []).forEach(function (an) {
      if (an.subtype !== "Widget" || !an.rect) return;
      var a = vp.convertToViewportPoint(an.rect[0], an.rect[1]), b = vp.convertToViewportPoint(an.rect[2], an.rect[3]);
      var r = { x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]), y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]), acro: an.fieldName };
      if (an.fieldType === "Btn" && (an.checkBox || an.radioButton)) boxes.push(r);
      else if (an.fieldType === "Tx") {
        if (r.y1 - r.y0 > 26 || an.multiLine) cells.push(Object.assign(r, { kind: "box" }));
        else lines.push({ x0: r.x0, x1: r.x1, y: r.y1 - 2, acro: an.fieldName });
      }
    });

    // -- squares (checkboxes) from horizontal pairs
    var usedH = new Set();
    H.forEach(function (h1, i) {
      var w = h1.x1 - h1.x0; if (w < 5 || w > 18 || usedH.has(i)) return;
      for (var j = 0; j < H.length; j++) {
        if (j === i || usedH.has(j)) continue;
        var h2 = H[j], d = h2.y - h1.y;
        if (Math.abs(h2.x0 - h1.x0) < 1.2 && Math.abs(h2.x1 - h1.x1) < 1.2 && d > w * 0.6 && d < w * 1.4) {
          // need vertical sides
          var sides = V.filter(function (v) { return (Math.abs(v.x - h1.x0) < 1.5 || Math.abs(v.x - h1.x1) < 1.5) && v.y0 < h1.y + 1.5 && v.y1 > h2.y - 1.5; });
          if (sides.length >= 1 || V.length === 0) {
            boxes.push({ x0: h1.x0, x1: h1.x1, y0: h1.y, y1: h2.y });
            usedH.add(i); usedH.add(j); break;
          }
        }
      }
    });
    function inBox(x, y) { return boxes.some(function (b) { return x > b.x0 - 1.5 && x < b.x1 + 1.5 && y > b.y0 - 1.5 && y < b.y1 + 1.5; }); }
    var V2 = V.filter(function (v) { return !inBox(v.x, (v.y0 + v.y1) / 2); });

    // -- glyph checkboxes and underscore runs in text
    items.forEach(function (it) {
      var s = it.str, n = Array.from(s).length, cw = (it.x1 - it.x0) / Math.max(1, n);
      var vis = it.dir === "rtl" ? Array.from(s).reverse() : Array.from(s);
      vis.forEach(function (ch, k) {
        if (BOX_GLYPHS.test(ch)) {
          var sz = Math.min(it.fs * 0.75, 12), cx = it.x0 + cw * (k + 0.5);
          boxes.push({ x0: cx - sz / 2, x1: cx + sz / 2, y0: it.base - sz * 0.9, y1: it.base + sz * 0.1, glyph: true });
        }
      });
      var str = vis.join(""), re = /_{4,}/g, m;
      while ((m = re.exec(str))) {
        lines.push({ x0: it.x0 + cw * m.index, x1: it.x0 + cw * (m.index + m[0].length), y: it.base + it.fs * 0.12 });
      }
    });

    // -- answer lines: horizontal segments not part of boxes or tables, not underlining text
    H.forEach(function (h, i) {
      if (usedH.has(i)) return;
      var w = h.x1 - h.x0; if (w < 16) return;
      var touch = V2.some(function (v) {
        return v.x > h.x0 - 1.5 && v.x < h.x1 + 1.5 && v.y0 < h.y + 1.5 && v.y1 > h.y - 1.5;
      });
      if (touch) return;
      var underline = items.some(function (it) {
        return it.bottom > h.y - 4 && it.bottom < h.y + 2.5 && overlapX(it.x0, it.x1, h.x0, h.x1) > Math.min(w, it.x1 - it.x0) * 0.6 && !/^_+$/.test(it.str.trim());
      });
      if (underline) return;
      if (w > vp.width * 0.8) return; // page-wide rule, not an answer line
      lines.push({ x0: h.x0, x1: h.x1, y: h.y });
    });

    // -- empty cells (table cells and standalone boxes)
    var hs = H.filter(function (h, i) { return !usedH.has(i) && h.x1 - h.x0 >= 20; });
    V2.forEach(function (vl) {
      // nearest vertical to the right overlapping in y
      var best = null;
      V2.forEach(function (vr) {
        if (vr.x <= vl.x + 15) return;
        var oy0 = Math.max(vl.y0, vr.y0), oy1 = Math.min(vl.y1, vr.y1);
        if (oy1 - oy0 < 8) return;
        if (!best || vr.x < best.x) best = vr;
      });
      if (!best) return;
      var x0 = vl.x, x1 = best.x, oy0 = Math.max(vl.y0, best.y0), oy1 = Math.min(vl.y1, best.y1);
      var ys = hs.filter(function (h) { return h.x0 < x0 + 2 && h.x1 > x1 - 2 && h.y > oy0 - 1.5 && h.y < oy1 + 1.5; })
        .map(function (h) { return h.y; }).sort(function (a, b) { return a - b; });
      for (var k = 0; k + 1 < ys.length; k++) {
        var y0 = ys[k], y1 = ys[k + 1];
        if (y1 - y0 < 9 || y1 - y0 > 250) continue;
        cells.push({ x0: x0, x1: x1, y0: y0, y1: y1, kind: "cell" });
      }
    });
    // dedupe cells
    var uniq = [];
    cells.forEach(function (c) { if (!uniq.some(function (u) { return Math.abs(u.x0 - c.x0) < 2 && Math.abs(u.x1 - c.x1) < 2 && Math.abs(u.y0 - c.y0) < 2 && Math.abs(u.y1 - c.y1) < 2; })) uniq.push(c); });
    cells = uniq.filter(function (c) {
      if (c.acro) return true;
      var hasText = items.some(function (it) { var cy = (it.top + it.bottom) / 2; return cy > c.y0 && cy < c.y1 && overlapX(it.x0, it.x1, c.x0, c.x1) > 1; });
      var hasBox = boxes.some(function (b) { return b.x0 >= c.x0 - 1 && b.x1 <= c.x1 + 1 && b.y0 >= c.y0 - 1 && b.y1 <= c.y1 + 1; });
      var hasLine = lines.some(function (l) { return l.y > c.y0 && l.y < c.y1 + 1 && l.x0 >= c.x0 - 1 && l.x1 <= c.x1 + 1; });
      var cellsInside = false;
      return !hasText && !hasBox && !hasLine && !cellsInside && (c.x1 - c.x0) >= 25;
    });
    // drop cells that contain other cells (keep the smallest)
    cells = cells.filter(function (c) {
      return !cells.some(function (d) { return d !== c && d.x0 >= c.x0 - 1 && d.x1 <= c.x1 + 1 && d.y0 >= c.y0 - 1 && d.y1 <= c.y1 + 1 && (d.x1 - d.x0) * (d.y1 - d.y0) < (c.x1 - c.x0) * (c.y1 - c.y0) - 4; });
    });

    // ---- labels ----
    function rowItems(yTop, yBot) { return items.filter(function (it) { var cy = (it.top + it.bottom) / 2; return cy > yTop && cy < yBot; }); }
    function joinRead(arr) {
      arr = arr.slice().sort(function (a, b) {
        if (Math.abs(a.base - b.base) > 3) return a.base - b.base;
        return rtl ? b.x1 - a.x1 : a.x0 - b.x0;
      });
      return arr.map(function (a) { return a.str.trim(); }).filter(function (s) { return s && !/^_+$/.test(s); }).join(" ").replace(/\s+/g, " ").trim();
    }
    var blockers = boxes.map(function (b) { return { x0: b.x0, x1: b.x1, cy: (b.y0 + b.y1) / 2 }; })
      .concat(lines.map(function (l) { return { x0: l.x0, x1: l.x1, cy: l.y - 4 }; }));
    // collect contiguous text on a row starting at x going in direction dir (+1 right, -1 left)
    function sideText(x, cy, dir, maxGap, h) {
      var row = rowItems(cy - (h || 7), cy + (h || 5)).filter(function (it) { return !/^_+$/.test(it.str.trim()); });
      var got = [], edge = x;
      for (;;) {
        var cand = row.filter(function (it) { return got.indexOf(it) < 0 && (dir > 0 ? it.x0 >= edge - 3 && it.x0 - edge < maxGap : it.x1 <= edge + 3 && edge - it.x1 < maxGap); });
        if (!cand.length) break;
        cand.sort(function (a, b) { return dir > 0 ? a.x0 - b.x0 : b.x1 - a.x1; });
        var nx = cand[0];
        var blocked = blockers.some(function (b) { return Math.abs(b.cy - cy) < 7 && (dir > 0 ? b.x0 > edge + 1 && b.x1 < nx.x0 + 1 : b.x1 < edge - 1 && b.x0 > nx.x1 - 1); });
        if (blocked) break;
        got.push(nx); edge = dir > 0 ? nx.x1 : nx.x0;
      }
      return got;
    }
    function textAbove(x0, x1, y, maxDist) {
      var c = items.filter(function (it) { return it.bottom <= y + 1 && y - it.bottom < maxDist && overlapX(it.x0, it.x1, x0, x1) > 0; });
      if (!c.length) return "";
      var nearest = Math.max.apply(null, c.map(function (it) { return it.bottom; }));
      return joinRead(c.filter(function (it) { return Math.abs(it.bottom - nearest) < 3; }));
    }

    var fields = [];
    var readStart = rtl ? 1 : -1; // label side for lines: before the line in reading order (RTL: to the right)
    var used = new Set();
    function free(arr) { return arr.filter(function (it) { return !used.has(it); }); }
    function take(arr) { arr.forEach(function (it) { used.add(it); }); return arr; }

    // ---- checkbox groups (first, so their option texts are not used as labels of lines) ----
    boxes.sort(function (a, b) { return a.y0 - b.y0 || (rtl ? b.x0 - a.x0 : a.x0 - b.x0); });
    var rows = [];
    boxes.forEach(function (b) {
      var cy = (b.y0 + b.y1) / 2, g = rows.filter(function (g) { return Math.abs(g.cy - cy) < 3; })[0];
      if (!g) { g = { cy: cy, boxes: [] }; rows.push(g); }
      g.boxes.push(b);
    });
    var choiceFields = [];
    rows.forEach(function (row) {
      var bs = row.boxes.sort(function (a, b) { return rtl ? b.x0 - a.x0 : a.x0 - b.x0; }), cy = row.cy;
      var optItems = bs.map(function (b) { return sideText(rtl ? b.x0 : b.x1, cy, -readStart, 6, 6); });
      var isTable = optItems.every(function (o) { return !o.length; });
      if (isTable && bs.length === 1) {
        var b1 = bs[0];
        var cellT = items.filter(function (it) { var c = (it.top + it.bottom) / 2; return c > b1.y0 - 6 && c < b1.y1 + 30 && (rtl ? it.x1 <= b1.x0 + 1 : it.x0 >= b1.x1 - 1); });
        // keep only text until the next box below
        var nextY = Math.min.apply(null, [1e9].concat(boxes.filter(function (o) { return o.y0 > b1.y1 + 2; }).map(function (o) { return o.y0; })));
        cellT = cellT.filter(function (it) { return it.top < nextY - 4; });
        choiceFields.push({ type: "choice", p: pageIndex, y: cy, rtl: rtl, label: joinRead(take(cellT)), options: [{ v: "", b: b1 }] });
        return;
      }
      if (isTable) {
        var rowT = rowItems(cy - 6, cy + 6).filter(function (it) { return !bs.some(function (b) { return overlapX(it.x0, it.x1, b.x0, b.x1) > 0; }); });
        var f = { type: "choice", p: pageIndex, y: cy, table: true, rtl: rtl, label: joinRead(take(rowT)).replace(/[:：]\s*$/, ""),
          options: bs.map(function (b) { return { v: textAbove(b.x0 - 6, b.x1 + 6, b.y0, 400) || "", b: b }; }) };
        choiceFields.push(f); return;
      }
      var cur = null;
      bs.forEach(function (b, k) {
        var oi = take(optItems[k]);
        if (!cur) {
          var q = free(sideText(rtl ? b.x1 : b.x0, cy, readStart, 70, 6));
          cur = { type: "choice", p: pageIndex, y: cy, rtl: rtl, label: joinRead(take(q)), options: [] };
          choiceFields.push(cur);
        }
        cur.options.push({ v: joinRead(oi), b: b, items: oi });
        // leftover text between this option and the next box starts a new question
        var nb = bs[k + 1];
        if (nb) {
          var edge = oi.length ? (rtl ? Math.min.apply(null, oi.map(function (i) { return i.x0; })) : Math.max.apply(null, oi.map(function (i) { return i.x1; }))) : (rtl ? b.x0 : b.x1);
          var between = free(rowItems(cy - 6, cy + 5)).filter(function (it) { return rtl ? it.x1 <= edge + 1 && it.x0 >= nb.x1 - 1 : it.x0 >= edge - 1 && it.x1 <= nb.x0 + 1; });
          if (between.length) {
            cur = { type: "choice", p: pageIndex, y: cy, rtl: rtl, label: joinRead(take(between)), options: [] };
            choiceFields.push(cur);
          }
        }
      });
    });
    choiceFields = choiceFields.filter(function (f) {
      // a lone box in the middle of an instruction sentence ("mark ☐ next to each...") is an example, not a field
      return !(f.options.length === 1 && f.label && f.options[0].v && Array.from(f.options[0].v).length > 12 && !f.table);
    });
    choiceFields.forEach(function (f) {
      if (f.options.length === 1 && !f.table) {
        var b = f.options[0].b, txt = f.options[0].v ? [] : null;
        // statement text: the option text continues on the following lines
        var below = items.filter(function (it) { return !used.has(it) && it.top > b.y1 - 1 && it.top < b.y1 + 40 && (rtl ? it.x1 <= b.x0 + 1 : it.x0 >= b.x1 - 1); });
        var nextY = Math.min.apply(null, [1e9].concat(boxes.filter(function (o) { return o.y0 > b.y1 + 2; }).map(function (o) { return o.y0; })));
        below = below.filter(function (it) { return it.top < nextY - 3; });
        // stop at a gap of more than one line
        below.sort(function (a, c) { return a.base - c.base; });
        var lastB = (b.y0 + b.y1) / 2 + 4, keep = [];
        below.forEach(function (it) { if (it.base - lastB < 15) { keep.push(it); lastB = Math.max(lastB, it.base); } });
        if (keep.length) {
          if (f.options[0].v) f.options[0].v += " " + joinRead(take(keep));
          else f.label += " " + joinRead(take(keep));
        }
      }
    });
    choiceFields.forEach(function (f) {
      f.label = (f.label || "").replace(/[:：]\s*$/, "");
      var CHK = rtl ? "מסומן" : "✓";
      if (f.options.length === 1 && !f.label) { f.label = f.options[0].v; f.options[0].v = CHK; }
      if (f.options.length === 1 && !f.options[0].v) f.options[0].v = CHK;
      var vals = f.options.map(function (o, k) { return (o.v || "").replace(/[:：]\s*$/, "") || "אפשרות " + (k + 1); });
      f.options.forEach(function (o, k) { o.v = vals[k]; delete o.items; });
      var yesno = vals.length > 1 && vals.every(function (v) { return /^(כן|לא|לפעמים|אולי|yes|no|sometimes|n\/a|זכר|נקבה)$/i.test(v.trim()); });
      f.multi = !yesno;
      fields.push(f);
    });

    lines.forEach(function (l) {
      var cy = l.y - 5, lab = "";
      if (l.acro) lab = "";
      var s1 = free(sideText(rtl ? l.x1 : l.x0, cy, readStart, 30));
      // drop a short unit word (e.g. ק"ג) that belongs to the previous line on the row
      if (s1.length > 1) {
        var far = s1[s1.length - 1];
        var farEdge = rtl ? far.x1 : far.x0;
        var nearLine = lines.some(function (o) { return o !== l && Math.abs(o.y - l.y) < 3 && (rtl ? o.x0 - farEdge < 8 && o.x0 >= farEdge - 2 : farEdge - o.x1 < 8 && farEdge >= o.x1 - 2); });
        if (nearLine && Array.from(far.str.trim()).length <= 5) s1 = s1.slice(0, -1);
      }
      lab = joinRead(s1);
      if (!lab) {
        var s2 = sideText(rtl ? l.x1 : l.x0, cy, readStart, 30);
        if (s2.length) {
          var owner = choiceFields.filter(function (f) { return f.p === pageIndex && Math.abs(f.y - cy) < 8; })[0];
          lab = owner && owner.label ? owner.label + " - " + (owner.table ? "פירוט" : joinRead(s2)) : joinRead(s2);
        }
      }
      if (!lab) lab = joinRead(free(sideText(rtl ? l.x0 : l.x1, cy, -readStart, 30)));
      if (!lab) {
        // a line on its own row right under a choice group with "other" -> details for that option
        var g = choiceFields.filter(function (f) { return f.p === pageIndex && l.y - f.y > 0 && l.y - f.y < 22 && f.options.some(function (o) { return /^(אחר|other)/i.test(o.v); }); })[0];
        if (g) lab = (g.label ? g.label + " - " : "") + "אחר (פירוט)";
      }
      if (!lab) lab = textAbove(l.x0, l.x1, l.y - 10, 22);
      fields.push({ type: "line", p: pageIndex, x0: l.x0, x1: l.x1, y: l.y, label: lab.replace(/[:：]\s*$/, ""), acro: l.acro, rtl: rtl });
    });

    cells.forEach(function (c) {
      var row = rowItems(c.y0 + 1, c.y1 - 1).filter(function (it) { return it.x1 <= c.x0 + 1 || it.x0 >= c.x1 - 1; });
      var rowLab = "";
      if (row.length) {
        var side = row.filter(function (it) { return rtl ? it.x0 >= c.x1 - 1 : it.x1 <= c.x0 + 1; });
        rowLab = joinRead(side.length ? side : row);
      }
      var colLab = textAbove(c.x0, c.x1, c.y0, rowLab ? 300 : 40);
      var lab = rowLab && colLab ? rowLab + " - " + colLab : (rowLab || colLab);
      fields.push({ type: "box", p: pageIndex, x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1, label: lab.replace(/[:：]\s*$/, ""), acro: c.acro, rtl: rtl, inTable: !!rowLab });
    });

    // order: top to bottom, reading direction
    fields.forEach(function (f) { f.sortY = f.type === "line" ? f.y - 4 : f.type === "box" ? f.y0 : f.y; f.sortX = f.type === "choice" ? f.options[0].b.x0 : f.x0; });
    fields.sort(function (a, b) { return Math.abs(a.sortY - b.sortY) > 4 ? a.sortY - b.sortY : (rtl ? b.sortX - a.sortX : a.sortX - b.sortX); });
    return { fields: fields, rtl: rtl, width: vp.width, height: vp.height, items: items };
  }

  root.detectPage = detectPage;
  if (typeof module !== "undefined") module.exports = { detectPage: detectPage };
})(typeof window !== "undefined" ? window : globalThis);
