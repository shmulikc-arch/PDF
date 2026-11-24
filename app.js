(function () {
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function today() { var d = new Date(); return ("0" + d.getDate()).slice(-2) + "/" + ("0" + (d.getMonth() + 1)).slice(-2) + "/" + d.getFullYear(); }
  function say(t, cls) { var m = $("msg"); m.textContent = t || ""; m.className = "msg " + (cls || ""); }

  // pdf.js worker: inline copy (single-file build) or the file next to the page
  (function () {
    var w = document.getElementById("pdfw");
    if (w) pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([w.textContent], { type: "text/javascript" }));
    else pdfjsLib.GlobalWorkerOptions.workerSrc = "pdf.worker.min.js";
  })();

  var state = null; // { name, bytes, fields, answers, viewports, canvases, rtl }
  var SCALE = 2;

  function cleanLabel(s) {
    s = String(s || "").replace(/\s+/g, " ").trim();
    // pdf.js keeps the visual glyphs of brackets in RTL text: swap them when they appear reversed
    var o = s.indexOf("("), c = s.indexOf(")");
    if (/[֐-׿]/.test(s) && c >= 0 && (o < 0 || c < o)) s = s.replace(/[()]/g, function (ch) { return ch === "(" ? ")" : "("; });
    s = s.replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").replace(/\s+([,.?:])/g, "$1");
    s = s.replace(/^[:：.\s]+|[:：\s]+$/g, "");
    return s;
  }
  var ID_RX = /^(שם|שם מלא|שם פרטי|שם משפחה|ת\.?ז\.?|תעודת זהות|מספר זהות|טלפון|נייד|טלפון נייד|דוא"ל|דואל|אימייל|מייל|כתובת|תאריך|full name|name|date|phone|email|e-mail|address|id)$/i;
  function normKey(s) { return s.replace(/[\s:."'״׳-]/g, "").toLowerCase(); }

  async function loadPdf(file) {
    say("קוראת את הקובץ...");
    $("upload").classList.add("busy");
    var buf = new Uint8Array(await file.arrayBuffer());
    var pdf = await pdfjsLib.getDocument({ data: buf.slice(0), disableAutoFetch: true, isEvalSupported: false }).promise;
    var fields = [], viewports = [], canvases = [], rtlVotes = 0;
    for (var i = 1; i <= pdf.numPages; i++) {
      say("מנתחת עמוד " + i + " מתוך " + pdf.numPages + "...");
      var page = await pdf.getPage(i), vp = page.getViewport({ scale: 1 });
      viewports.push(vp);
      var res = detectPage(pdfjsLib.OPS, await page.getOperatorList({ annotationMode: pdfjsLib.AnnotationMode.DISABLE }), await page.getTextContent(), vp, await page.getAnnotations(), i - 1);
      if (res.rtl) rtlVotes++; else rtlVotes--;
      res.fields.forEach(function (f) { fields.push(f); });
      canvases.push(null);
    }
    state = { name: file.name, bytes: buf, fields: fields, answers: {}, viewports: viewports, canvases: canvases, rtl: rtlVotes >= 0 };
    prepare();
    render();
    $("upload").classList.remove("busy");
    say("");
  }

  // assign keys, kinds, defaults
  function prepare() {
    var seen = {};
    state.fields.forEach(function (f, i) {
      f.label = cleanLabel(f.label);
      if (f.type === "choice") f.options.forEach(function (o) { o.v = cleanLabel(o.v) || o.v; });
      var lab = f.label, short = lab.replace(/\s*\(.*\)\s*/g, "").trim();
      if ((f.type === "line" || f.type === "box") && /(^|\s)(חתימה|חתימת|signature)/i.test(lab) && Array.from(lab).length < 40) {
        f.kind = "sign"; f.key = "__sig"; return;
      }
      if (f.type === "line" && ID_RX.test(short)) {
        var k = "id:" + normKey(short);
        f.key = k; f.shared = !!seen[k]; seen[k] = true;
        if (/^(תאריך|date)$/i.test(short) && !state.answers[k]) state.answers[k] = today();
        return;
      }
      if (f.type === "line" && /תאריך/.test(lab) && !/לידה|birth/i.test(lab) && Array.from(lab).length < 30) {
        f.key = "f" + i; state.answers[f.key] = today(); return;
      }
      f.key = "f" + i;
    });
  }

  // crop of the rendered page around a field, with the answer area highlighted
  function snippet(f) {
    var cv = state.canvases[f.p], W = cv.width / SCALE, top, bot, hl = [];
    if (f.type === "line") { top = f.y - 18; bot = f.y + 7; hl.push([f.x0, f.y - 12, f.x1, f.y + 2]); }
    else if (f.type === "box") { top = f.y0 - 16; bot = f.y1 + 4; hl.push([f.x0, f.y0, f.x1, f.y1]); }
    else {
      var ys = f.options.map(function (o) { return [o.b.y0, o.b.y1]; });
      top = Math.min.apply(null, ys.map(function (y) { return y[0]; })) - 8 - (f.padTop || 0);
      bot = Math.max.apply(null, ys.map(function (y) { return y[1]; })) + 8;
      f.options.forEach(function (o) { hl.push([o.b.x0 - 1.5, o.b.y0 - 1.5, o.b.x1 + 1.5, o.b.y1 + 1.5]); });
    }
    top = Math.max(0, top); bot = Math.min(cv.height / SCALE, bot);
    // horizontal crop: the field plus room for its label on the reading-start side
    var fx0 = Math.min.apply(null, hl.map(function (h) { return h[0]; })), fx1 = Math.max.apply(null, hl.map(function (h) { return h[2]; }));
    var rtl = f.rtl !== false && state.rtl;
    var left = rtl ? fx0 - 20 : fx0 - 150, right = rtl ? fx1 + 150 : fx1 + 20;
    if (right - left < 220) { var pad = (220 - (right - left)) / 2; left -= pad; right += pad; }
    if (left < 0) { right -= left; left = 0; } if (right > W) { left -= right - W; right = W; }
    left = Math.max(0, left);
    var out = document.createElement("canvas");
    out.width = Math.round((right - left) * SCALE); out.height = Math.round((bot - top) * SCALE);
    var c = out.getContext("2d");
    c.drawImage(cv, left * SCALE, top * SCALE, out.width, out.height, 0, 0, out.width, out.height);
    c.fillStyle = "rgba(255, 196, 0, 0.28)"; c.strokeStyle = "rgba(214, 140, 0, 0.9)"; c.lineWidth = 2;
    hl.forEach(function (h) {
      var x = (h[0] - left) * SCALE, y = (h[1] - top) * SCALE, w = (h[2] - h[0]) * SCALE, hh = (h[3] - h[1]) * SCALE;
      c.fillRect(x, y, w, hh); c.strokeRect(x, y, w, hh);
    });
    out.className = "snip";
    out.style.width = Math.round((right - left) * 1.5) + "px";
    return out;
  }

  function textInput(key, multiline) {
    var i = el(multiline ? "textarea" : "input");
    if (!multiline) i.type = "text";
    i.value = state.answers[key] || "";
    i.addEventListener("input", function () { state.answers[key] = i.value; progress(); });
    return i;
  }

  function choiceInput(f) {
    var box = el("div", "pills"), multi = f.multi;
    function sel() { var v = state.answers[f.key]; return multi ? (v || []) : (v == null ? [] : [v]); }
    function paint() { Array.prototype.forEach.call(box.children, function (b, i) { b.classList.toggle("on", sel().indexOf(i) >= 0); }); }
    f.options.forEach(function (o, i) {
      var b = el("button", "pill" + (multi ? "" : " radio")); b.type = "button"; b.textContent = o.v;
      b.addEventListener("click", function () {
        if (multi) { var s = sel().slice(), k = s.indexOf(i); if (k >= 0) s.splice(k, 1); else s.push(i); state.answers[f.key] = s; }
        else state.answers[f.key] = state.answers[f.key] === i ? null : i;
        paint(); progress();
      });
      box.appendChild(b);
    });
    paint();
    return box;
  }

  var sigCanvas = null, sigInk = false;
  function signaturePad() {
    var w = el("div"), box = el("div", "sig"), c = el("canvas"), hint = el("div", "hint", "חתמו כאן באצבע או בעכבר");
    box.appendChild(c); box.appendChild(hint); w.appendChild(box);
    var clr = el("button", "linkbtn", "ניקוי חתימה"); clr.type = "button"; w.appendChild(clr);
    sigCanvas = c; sigInk = false;
    var ctx, drawing = false, last;
    function setup() {
      var r = c.getBoundingClientRect(), dpr = Math.max(2, window.devicePixelRatio || 1);
      c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
      ctx = c.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineWidth = 2.4; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#13339e"; ctx.fillStyle = "#13339e";
      sigInk = false; hint.style.display = "";
    }
    function pt(e) { var r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    c.addEventListener("pointerdown", function (e) { drawing = true; last = pt(e); try { c.setPointerCapture(e.pointerId); } catch (x) {} hint.style.display = "none"; ctx.beginPath(); ctx.arc(last.x, last.y, 1.1, 0, 7); ctx.fill(); sigInk = true; progress(); });
    c.addEventListener("pointermove", function (e) { if (!drawing) return; var p = pt(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; });
    c.addEventListener("pointerup", function () { drawing = false; });
    c.addEventListener("pointercancel", function () { drawing = false; });
    clr.addEventListener("click", function () { setup(); progress(); });
    requestAnimationFrame(setup);
    return w;
  }
  function sigPng() {
    if (!sigCanvas || !sigInk) return null;
    var c = sigCanvas, d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    var minX = c.width, minY = c.height, maxX = -1, maxY = -1;
    for (var y = 0; y < c.height; y++) for (var x = 0; x < c.width; x++) {
      if (d[(y * c.width + x) * 4 + 3] > 10) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    if (maxX < 0) return null;
    var pad = 6, w = maxX - minX + 1 + pad * 2, h = maxY - minY + 1 + pad * 2, o = document.createElement("canvas");
    o.width = w; o.height = h; o.getContext("2d").drawImage(c, minX - pad, minY - pad, w, h, 0, 0, w, h);
    var b64 = o.toDataURL("image/png").split(",")[1];
    return Uint8Array.from(atob(b64), function (ch) { return ch.charCodeAt(0); });
  }

  var countable = [];
  function render() {
    var form = $("form"); form.innerHTML = ""; countable = [];
    $("upload").hidden = true; $("work").hidden = false; $("dock").hidden = false;
    $("fname").textContent = state.name;
    document.documentElement.dir = "rtl";
    var hasSign = state.fields.some(function (f) { return f.kind === "sign"; });
    var visible = state.fields.filter(function (f) { return f.kind !== "sign" && !f.shared; });
    $("summary").textContent = visible.length ? "נמצאו " + visible.length + " שאלות ב-" + state.canvases.length + " עמודים" + (hasSign ? ", ומקום לחתימה" : "") + "." : "";
    if (!visible.length && !hasSign) {
      form.appendChild(el("section", "card", "<h2>לא נמצאו מקומות למילוי</h2><p class='note'>לא זיהיתי בקובץ הזה שורות, תיבות סימון או תאים ריקים. זה קורה בעיקר בקובץ סרוק (תמונה של דף). נסו קובץ PDF שנוצר במחשב.</p>"));
      $("dock").hidden = true;
      return;
    }
    var byPage = {};
    state.fields.forEach(function (f) { (byPage[f.p] = byPage[f.p] || []).push(f); });
    Object.keys(byPage).forEach(function (p) {
      var list = byPage[p].filter(function (f) { return f.kind !== "sign" && !f.shared; });
      if (!list.length) return;
      var card = el("section", "card");
      card.appendChild(el("h2", null, "עמוד " + (+p + 1)));
      var prevTable = false;
      list.forEach(function (f) {
        var q = el("div", "f" + (f.table ? " trow" : ""));
        var lab = f.label || (f.type === "choice" ? "סימון" : "תשובה");
        if (f.table) {
          if (!prevTable) {
            var run = [], k = list.indexOf(f);
            while (k < list.length && list[k].table) run.push(list[k++]);
            q.appendChild(el("div", "tablehint", "טבלה: סמנו תשובה בכל שורה"));
          }
          q.appendChild(el("div", "lbl", esc(lab)));
          q.appendChild(choiceInput(f));
        } else {
          q.appendChild(el("div", "lbl", esc(lab)));
          if (f.type === "choice") q.appendChild(choiceInput(f));
          else q.appendChild(textInput(f.key, f.type === "box" && !f.inTable));
        }
        prevTable = !!f.table;
        card.appendChild(q);
        countable.push(f);
      });
      form.appendChild(card);
    });
    if (hasSign) {
      var sc = el("section", "card");
      sc.appendChild(el("h2", null, "חתימה"));
      var n = state.fields.filter(function (f) { return f.kind === "sign"; }).length;
      sc.appendChild(el("p", "note", n > 1 ? "החתימה תיכנס בכל " + n + " מקומות החתימה במסמך." : "החתימה תיכנס במקום החתימה במסמך."));
      sc.appendChild(signaturePad());
      form.appendChild(sc);
    }
    progress();
    window.scrollTo(0, 0);
  }
  function tableSnippet(run) {
    var opts = [];
    run.forEach(function (f) { f.options.forEach(function (o) { opts.push(o); }); });
    var fake = { type: "choice", p: run[0].p, options: opts, padTop: 16 };
    var c = snippet(fake);
    // include the header row above the first row
    return c;
  }

  function filled(f) {
    var v = state.answers[f.key];
    if (f.type === "choice") return f.multi ? v && v.length : v != null;
    return v && String(v).trim();
  }
  function progress() {
    if (!state) return;
    var n = countable.filter(filled).length;
    $("bar").style.width = (countable.length ? Math.round(n / countable.length * 100) : 0) + "%";
    $("ptext").textContent = "מולאו " + n + " מתוך " + countable.length;
  }

  // ---- output ----
  var lastUrl = null;
  async function getDownloads() {
    try {
      if (window.claude && typeof window.claude.use === "function")
        return await Promise.race([window.claude.use("downloads"), new Promise(function (r) { setTimeout(function () { r(null); }, 1500); })]);
    } catch (e) {}
    return null;
  }
  async function generate() {
    var go = $("go"); go.disabled = true; say("מכינה את הקובץ..."); $("result").classList.remove("show");
    try {
      var vps = state.viewports;
      var bytes = await fillPdf({
        PDFLib: PDFLib, fontkit: fontkit, pdfBytes: state.bytes.slice(0),
        fontBytes: Uint8Array.from(atob(Q_FONT_B64), function (c) { return c.charCodeAt(0); }),
        fields: state.fields, answers: state.answers, sigPng: sigPng(),
        toPdf: function (p, x, top) { return vps[p].convertToPdfPoint(x, top); }
      });
      var base = state.name.replace(/\.pdf$/i, "");
      var filename = base + " - מלא.pdf";
      var blob = new Blob([bytes], { type: "application/pdf" });
      showResult(blob, filename, await getDownloads());
      say("");
    } catch (e) { console.error(e); say("שגיאה בהפקת הקובץ: " + (e && e.message || e), "err"); }
    go.disabled = false;
  }
  function showResult(blob, filename, dl) {
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = URL.createObjectURL(blob);
    var acts = $("acts"); acts.innerHTML = "";
    var file = null; try { file = new File([blob], filename, { type: "application/pdf" }); } catch (e) {}
    if (dl) {
      var b0 = el("button", "act", "שמירת ה-PDF"); b0.type = "button";
      b0.addEventListener("click", async function () {
        try { await dl.save({ filename: filename, data: blob }); say("הקובץ נשמר.", "ok"); }
        catch (e) { say(e && e.code === "declined" ? "השמירה בוטלה." : "השמירה לא הצליחה כאן, נסו את הכפתורים האחרים.", "err"); }
      });
      acts.appendChild(b0);
    }
    var a = el("a", "act" + (dl ? " sec" : ""), "הורדת ה-PDF"); a.href = lastUrl; a.download = filename; acts.appendChild(a);
    if (file && navigator.canShare && navigator.share) {
      var ok = false; try { ok = navigator.canShare({ files: [file] }); } catch (e) {}
      if (ok) {
        var b1 = el("button", "act sec", "שליחה (ווטסאפ / מייל)"); b1.type = "button";
        b1.addEventListener("click", async function () {
          try { await navigator.share({ files: [file], title: filename }); } catch (e) { if (!e || e.name !== "AbortError") say("השיתוף לא הצליח, נסו להוריד.", "err"); }
        });
        acts.appendChild(b1);
      }
    }
    var o = el("a", "act sec", "פתיחה בלשונית חדשה"); o.href = lastUrl; o.target = "_blank"; o.rel = "noopener"; acts.appendChild(o);
    $("result").classList.add("show");
    $("result").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // ---- wiring ----
  function pick(file) {
    if (!file) return;
    if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) { say("צריך לבחור קובץ PDF.", "err"); return; }
    loadPdf(file).catch(function (e) {
      console.error(e); $("upload").classList.remove("busy");
      say(/password/i.test(String(e && e.name || e)) ? "הקובץ מוגן בסיסמה. צריך קובץ בלי סיסמה." : "לא הצלחתי לקרוא את הקובץ: " + (e && e.message || e), "err");
    });
  }
  $("file").addEventListener("change", function () { pick(this.files[0]); this.value = ""; });
  var dz = $("drop");
  ["dragenter", "dragover"].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add("over"); }); });
  ["dragleave", "drop"].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove("over"); }); });
  dz.addEventListener("drop", function (e) { pick(e.dataTransfer.files[0]); });
  $("go").addEventListener("click", generate);
  $("again").addEventListener("click", function () {
    var b = this;
    if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "בטוח? התשובות יימחקו"; setTimeout(function () { delete b.dataset.armed; b.textContent = "קובץ אחר"; }, 3500); return; }
    location.reload();
  });
  window.addEventListener("beforeunload", function (e) {
    if (state && Object.keys(state.answers).some(function (k) { var v = state.answers[k]; return v && (Array.isArray(v) ? v.length : String(v).trim() && !/^\d\d\/\d\d\/\d{4}$/.test(v)); })) { e.preventDefault(); e.returnValue = ""; }
  });
})();
