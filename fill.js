// Writes answers onto the original PDF. Coordinates come from detect.js (top-left page points);
// toPdf(pageIndex, x, top) converts them to PDF user space.
(function (root) {
  var MIRROR = { "(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{", "<": ">", ">": "<" };
  function isHeb(c) { var n = c.charCodeAt(0); return (n >= 0x0590 && n <= 0x05FF) || (n >= 0xFB1D && n <= 0xFB4F); }
  function isLtr(c) { return /[A-Za-z0-9À-ɏ@]/.test(c); }

  // visual (left-to-right drawing) order for a line; base direction RTL or LTR
  function visual(s, rtl) {
    var chars = Array.from(s), types = chars.map(function (c) { return isHeb(c) ? "R" : isLtr(c) ? "L" : "N"; });
    var base = rtl ? "R" : "L";
    for (var i = 0; i < chars.length; i++) {
      if (types[i] !== "N") continue;
      var j = i; while (j < chars.length && types[j] === "N") j++;
      var prev = i > 0 ? types[i - 1] : base, next = j < chars.length ? types[j] : base;
      var t = prev === next ? prev : base;
      for (var k = i; k < j; k++) types[k] = t;
      i = j - 1;
    }
    var runs = [], cur = null;
    for (var m = 0; m < chars.length; m++) {
      if (!cur || cur.t !== types[m]) { cur = { t: types[m], c: [] }; runs.push(cur); }
      cur.c.push(chars[m]);
    }
    if (rtl) runs.reverse();
    else {
      // LTR base: RTL runs are reversed in place
    }
    return runs.map(function (r) {
      return r.t === "L" ? r.c.join("") : r.c.slice().reverse().map(function (c) { return MIRROR[c] || c; }).join("");
    }).join("");
  }

  async function fillPdf(opts) {
    var PDFLib = opts.PDFLib, doc = await PDFLib.PDFDocument.load(opts.pdfBytes, { ignoreEncryption: true });
    doc.registerFontkit(opts.fontkit);
    try { // remove interactive form fields; answers are drawn instead
      var form = doc.getForm();
      form.getFields().forEach(function (f) { try { form.removeField(f); } catch (e) {} });
    } catch (e) {}
    var font = await doc.embedFont(opts.fontBytes, { subset: true });
    var charset = new Set(font.getCharacterSet());
    var pages = doc.getPages(), toPdf = opts.toPdf;
    var INK = PDFLib.rgb(0.07, 0.2, 0.62), BLACK = PDFLib.rgb(0.15, 0.15, 0.15);
    var overflow = [];

    function safe(s) {
      return Array.from(String(s == null ? "" : s).replace(/[‎‏‪-‮]/g, "").replace(/\t/g, " "))
        .map(function (ch) { return ch === "\n" || charset.has(ch.codePointAt(0)) ? ch : "?"; }).join("").trim();
    }
    function cw(ch, size) { return font.widthOfTextAtSize(ch, size); }
    function vw(v, size) { return Array.from(v).reduce(function (a, ch) { return a + cw(ch, size); }, 0); }
    function tw(t, size) { return vw(t, size); }
    function drawVis(page, v, x, y, size, color) {
      Array.from(v).forEach(function (ch) {
        if (ch !== " ") page.drawText(ch, { x: x, y: y, size: size, font: font, color: color });
        x += cw(ch, size);
      });
    }
    // draw one line at (xStart..xEnd) in top-left coords, aligned by direction
    function firstStrongRtl(t, dflt) {
      var m = /[A-Za-z\u00C0-\u024F]|[\u0590-\u05FF]/.exec(t);
      return m ? /[\u0590-\u05FF]/.test(m[0]) : dflt;
    }
    function drawLine(p, txt, x0, x1, baseTop, size, rtl, color) {
      var v = visual(txt, firstStrongRtl(txt, rtl)), w = vw(v, size);
      var x = rtl ? x1 - w : x0;
      var pt = toPdf(p, x, baseTop);
      drawVis(pages[p], v, pt[0], pt[1], size, color || INK);
    }
    function wrap(text, size, width) {
      var out = [];
      String(text).split(/\r?\n/).forEach(function (para) {
        var words = para.split(/\s+/).filter(Boolean), line = "";
        if (!words.length) { out.push(""); return; }
        words.forEach(function (w) {
          var test = line ? line + " " + w : w;
          if (tw(test, size) <= width) { line = test; return; }
          if (line) out.push(line);
          if (tw(w, size) > width) {
            var chunk = "";
            Array.from(w).forEach(function (ch) { if (tw(chunk + ch, size) > width && chunk) { out.push(chunk); chunk = ch; } else chunk += ch; });
            line = chunk;
          } else line = w;
        });
        out.push(line);
      });
      return out;
    }

    function onLine(f, txt) {
      txt = safe(txt); if (!txt) return;
      var width = f.x1 - f.x0 - 1, size = 9.5;
      while (size > 6 && tw(txt, size) > width) size -= 0.25;
      if (tw(txt, size) <= width) { drawLine(f.p, txt, f.x0 + 0.5, f.x1 - 0.5, f.y - 1.6, size, f.rtl); return; }
      var mark = f.rtl ? " (המשך בעמוד הנוסף)" : " (continued on extra page)", words = txt.split(/\s+/), part = "";
      for (var i = 0; i < words.length; i++) {
        var t = part ? part + " " + words[i] : words[i];
        if (tw(t + mark, 6) > width) break; part = t;
      }
      drawLine(f.p, (part ? part + "…" : "") + mark, f.x0 + 0.5, f.x1 - 0.5, f.y - 1.6, 6, f.rtl);
      overflow.push({ label: f.label, text: txt, rtl: f.rtl });
    }
    function inBox(f, txt, maxSize) {
      txt = safe(txt); if (!txt) return;
      var pad = 2.5, width = f.x1 - f.x0 - 2 * pad, height = f.y1 - f.y0 - 2 * pad, size = maxSize || 9.5, lines;
      for (;;) {
        lines = wrap(txt, size, width);
        if (lines.length * size * 1.18 <= height || size <= 5.5) break;
        size -= 0.25;
      }
      var lh = size * 1.18, maxLines = Math.max(1, Math.floor(height / lh));
      if (lines.length > maxLines) {
        lines = lines.slice(0, maxLines);
        lines[maxLines - 1] += f.rtl ? "… (המשך בעמוד הנוסף)" : "… (continued on extra page)";
        overflow.push({ label: f.label, text: txt, rtl: f.rtl });
      }
      var total = lines.length * lh, top = f.y0 + pad + (height - total) / 2;
      lines.forEach(function (ln, i) { drawLine(f.p, ln, f.x0 + pad, f.x1 - pad, top + (i + 1) * lh - size * 0.22, size, f.rtl); });
    }
    function check(p, b) {
      var s = Math.min(b.x1 - b.x0, b.y1 - b.y0), x = b.x0 + (b.x1 - b.x0 - s) / 2, yTop = b.y0 + (b.y1 - b.y0 - s) / 2;
      function P(fx, fy) { var q = toPdf(p, x + fx * s, yTop + fy * s); return { x: q[0], y: q[1] }; }
      var th = Math.max(1, s * 0.15);
      pages[p].drawLine({ start: P(0.17, 0.48), end: P(0.42, 0.8), thickness: th, color: INK });
      pages[p].drawLine({ start: P(0.42, 0.8), end: P(0.94, -0.06), thickness: th, color: INK });
    }

    var sigImg = opts.sigPng ? await doc.embedPng(opts.sigPng) : null;

    var GRAY = PDFLib.rgb(0.35, 0.35, 0.35);
    function rectOutline(p, x0, y0, x1, y1) {
      var a = toPdf(p, x0, y1), b = toPdf(p, x1, y0);
      pages[p].drawRectangle({ x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(b[0] - a[0]), height: Math.abs(b[1] - a[1]), borderColor: GRAY, borderWidth: 0.6 });
    }
    opts.fields.forEach(function (f) {
      if (f.acro && f.type === "line") { var a = toPdf(f.p, f.x0, f.y + 1), b = toPdf(f.p, f.x1, f.y + 1); pages[f.p].drawLine({ start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] }, thickness: 0.6, color: GRAY }); }
      if (f.acro && f.type === "box") rectOutline(f.p, f.x0, f.y0, f.x1, f.y1);
      if (f.type === "choice") f.options.forEach(function (o) { if (o.b.acro) rectOutline(f.p, o.b.x0, o.b.y0, o.b.x1, o.b.y1); });
    });
    opts.fields.forEach(function (f) {
      var v = opts.answers[f.key];
      if (f.kind === "sign") {
        if (!sigImg) return;
        var bw = f.x1 - f.x0, bh = Math.max(12, Math.min(22, f.sigH || 16));
        var sc = Math.min(bw / sigImg.width, bh / sigImg.height), w = sigImg.width * sc, h = sigImg.height * sc;
        var x = f.rtl ? f.x1 - w - (bw - w) / 2 : f.x0 + (bw - w) / 2;
        var pt = toPdf(f.p, x, f.y - 0.5);
        pages[f.p].drawImage(sigImg, { x: pt[0], y: pt[1], width: w, height: h });
        return;
      }
      if (f.type === "line") onLine(f, v);
      else if (f.type === "box") inBox(f, v, f.inTable ? 8.5 : 9.5);
      else if (f.type === "choice") {
        var sel = Array.isArray(v) ? v : (v == null || v === "" ? [] : [v]);
        f.options.forEach(function (o, i) { if (sel.indexOf(i) >= 0) check(f.p, o.b); });
      }
    });

    if (overflow.length) {
      var W = pages[0].getWidth(), H = pages[0].getHeight(), rtl = overflow[0].rtl;
      var pg = doc.addPage([W, H]), y = 60;
      function put(txt, size, color) {
        var v = visual(txt, rtl), w = vw(v, size);
        drawVis(pg, v, rtl ? W - 52 - w : 52, H - y, size, color);
      }
      put(rtl ? "המשך תשובות (תשובות שלא נכנסו במקום המיועד)" : "Continued answers", 12, BLACK); y += 24;
      overflow.forEach(function (o) {
        if (y > H - 70) { pg = doc.addPage([W, H]); y = 60; }
        put((o.label || "").replace(/[?:]+$/, "") + ":", 9.5, BLACK); y += 14;
        wrap(o.text, 10, W - 104).forEach(function (ln) {
          if (y > H - 50) { pg = doc.addPage([W, H]); y = 60; }
          put(ln, 10, INK); y += 13;
        });
        y += 10;
      });
    }
    return await doc.save();
  }

  root.fillPdf = fillPdf;
  root.bidiVisual = visual;
})(typeof window !== "undefined" ? window : globalThis);
