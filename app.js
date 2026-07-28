(function () {
  "use strict";

  const ALL_CODES = PREFECTURES.map((p) => p.code);
  const byCode = new Map(PREFECTURES.map((p) => [p.code, p]));

  const MODE_LABELS = {
    pref: "都道府県モード",
    capital: "県庁所在地モード",
    both: "両方モード",
    tap: "タップモード",
    browse: "閲覧モード",
  };
  const QUESTION_TEXT = {
    pref: "黄色の都道府県はどこ？",
    capital: "この県の県庁所在地は？",
    both: "黄色の都道府県名と県庁所在地は？",
    tap: "黄色の都道府県名と県庁所在地は？",
  };
  const TAP_IDLE_TEXT = "都道府県をタップして問題を選ぼう";

  const screenStart = document.getElementById("screen-start");
  const screenQuiz = document.getElementById("screen-quiz");
  const regionListEl = document.getElementById("region-list");
  const modeLabelEl = document.getElementById("mode-label");
  const backBtn = document.getElementById("back-btn");
  const tapArea = document.getElementById("tap-area");
  const promptNameEl = document.getElementById("prompt-name");
  const questionTextEl = document.getElementById("question-text");
  const svg = document.getElementById("japan-map");
  const answerBox = document.getElementById("answer-box");
  const answerPrefEl = document.getElementById("answer-pref");
  const answerCapitalEl = document.getElementById("answer-capital");
  const hintTextEl = document.getElementById("hint-text");
  const hintBtn = document.getElementById("hint-btn");
  const hintRevealEl = document.getElementById("hint-reveal");
  const capitalPinEl = document.getElementById("capital-pin");
  const browseControlsEl = document.getElementById("browse-controls");
  const namesToggle = document.getElementById("names-toggle");
  const capitalToggle = document.getElementById("capital-toggle");
  const prefLabelsEl = document.getElementById("pref-labels");
  const capitalLabelsEl = document.getElementById("capital-labels");

  // SVG要素では `.hidden = true/false` を代入しても hidden 属性に反映されず
  // 表示が変わらないことがあるため、属性を直接操作する
  function setSvgHidden(el, hidden) {
    if (hidden) {
      el.setAttribute("hidden", "");
    } else {
      el.removeAttribute("hidden");
    }
  }

  // 都道府県名そのものを当てるモードでのみヒントを出す（県庁所在地モードは
  // 県名が最初から表示されているので、県のヒントは意味がない）
  const HINT_MODES = new Set(["pref", "both", "tap"]);
  // 県庁所在地が答えに関わるモードでだけピンを表示する
  const CAPITAL_PIN_MODES = new Set(["capital", "both", "tap"]);
  const QUIZ_MODES = new Set(["pref", "capital", "both"]);

  const FULL_VIEWBOX = [0, 0, 1000, 1000];
  const ZOOM_PADDING = 2.4;
  const ZOOM_MIN_SIZE = 140;
  const ZOOM_DURATION = 450;

  let mode = null;
  let selectedRegionId = "all";
  let activeCodes = ALL_CODES;
  let pool = [];
  let lastCode = null;
  let currentCode = null;
  let showingAnswer = false;
  let hintShown = false;
  let highlightedEl = null;
  let currentViewBox = FULL_VIEWBOX.slice();
  let zoomAnimId = null;

  function renderRegionChips() {
    const all = [{ id: "all", label: "全国" }, ...REGIONS];
    regionListEl.innerHTML = "";
    for (const r of all) {
      const btn = document.createElement("button");
      btn.className = "region-chip" + (r.id === selectedRegionId ? " active" : "");
      btn.textContent = r.label;
      btn.dataset.regionId = r.id;
      btn.addEventListener("click", () => {
        selectedRegionId = r.id;
        renderRegionChips();
      });
      regionListEl.appendChild(btn);
    }
  }
  renderRegionChips();

  function getActiveCodes() {
    if (selectedRegionId === "all") return ALL_CODES;
    const region = REGIONS.find((r) => r.id === selectedRegionId);
    return region ? region.codes : ALL_CODES;
  }

  function getRegionLabel() {
    if (selectedRegionId === "all") return null;
    const region = REGIONS.find((r) => r.id === selectedRegionId);
    return region ? region.label : null;
  }

  const PAN_DRAG_THRESHOLD = 6; // px, before a pointer-down counts as a drag
  const MANUAL_ZOOM_MIN_SIZE = 40;

  const activePointers = new Map(); // pointerId -> {x, y} in client coords
  let gestureMode = null; // "pan" | "pinch" | null
  let gestureViewBox = null;
  let gestureAnchorMap = null; // map-space point that should stay under the finger(s)
  let gestureStartDistance = 0;
  let singleStartClientX = 0;
  let singleStartClientY = 0;
  let dragMoved = false;
  let suppressNextClick = false;

  function clamp(v, min, max) {
    return Math.min(Math.max(v, min), max);
  }

  // ラベルの文字は SVG のユーザー単位で固定サイズのため、ズームインする
  // ほど画面上では大きく見えてしまう。viewBox が縮むほどフォントサイズも
  // (平方根で緩やかに) 縮めて、拡大時の文字の肥大化を抑える。
  function updateLabelFontScale(viewBoxSize) {
    const scale = clamp(Math.sqrt(viewBoxSize / FULL_VIEWBOX[2]), 0.25, 1);
    svg.style.setProperty("--label-font-scale", scale);
  }

  function getRenderMetrics() {
    const rect = svg.getBoundingClientRect();
    const renderedSize = Math.min(rect.width, rect.height) || 1;
    return {
      renderedSize,
      offsetX: rect.left + (rect.width - renderedSize) / 2,
      offsetY: rect.top + (rect.height - renderedSize) / 2,
    };
  }

  function clientToMap(clientX, clientY, viewBox) {
    const { renderedSize, offsetX, offsetY } = getRenderMetrics();
    const scale = viewBox[2] / renderedSize;
    return {
      x: viewBox[0] + (clientX - offsetX) * scale,
      y: viewBox[1] + (clientY - offsetY) * scale,
    };
  }

  function setViewBoxCenteredOn(anchorMap, anchorClientX, anchorClientY, size) {
    const { renderedSize, offsetX, offsetY } = getRenderMetrics();
    const scale = size / renderedSize;
    let x = anchorMap.x - (anchorClientX - offsetX) * scale;
    let y = anchorMap.y - (anchorClientY - offsetY) * scale;
    x = clamp(x, 0, Math.max(0, FULL_VIEWBOX[2] - size));
    y = clamp(y, 0, Math.max(0, FULL_VIEWBOX[3] - size));
    currentViewBox = [x, y, size, size];
    svg.setAttribute("viewBox", currentViewBox.join(" "));
    updateLabelFontScale(size);
  }

  function startGesture() {
    gestureViewBox = currentViewBox.slice();
    const pts = Array.from(activePointers.values());
    if (pts.length === 1) {
      gestureMode = "pan";
      gestureAnchorMap = clientToMap(pts[0].x, pts[0].y, gestureViewBox);
    } else if (pts.length === 2) {
      gestureMode = "pinch";
      const midX = (pts[0].x + pts[1].x) / 2;
      const midY = (pts[0].y + pts[1].y) / 2;
      gestureAnchorMap = clientToMap(midX, midY, gestureViewBox);
      gestureStartDistance = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      dragMoved = true; // a two-finger gesture is never a tap
    } else {
      gestureMode = null;
    }
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function drawNextCode() {
    if (pool.length === 0) {
      pool = shuffle(activeCodes);
      if (pool.length > 1 && pool[pool.length - 1] === lastCode) {
        const swapIdx = Math.floor(Math.random() * (pool.length - 1));
        [pool[pool.length - 1], pool[swapIdx]] = [pool[swapIdx], pool[pool.length - 1]];
      }
    }
    const code = pool.pop();
    lastCode = code;
    return code;
  }

  function highlight(code) {
    if (highlightedEl) highlightedEl.style.fill = "";
    highlightedEl = svg.querySelector(`.prefecture[data-code="${code}"]`);
    if (highlightedEl) highlightedEl.style.fill = "#ffd400";
  }

  // getCTM()/getScreenCTM() map into rendered viewport pixels, which depends
  // on the SVG's *current* viewBox — useless for computing a new viewBox.
  // Walk the ancestor <g transform="..."> chain ourselves to get the
  // element's bounding box in the SVG's fixed abstract coordinate space.
  function getLocalToRootMatrix(el) {
    let matrix = new DOMMatrix();
    const chain = [];
    let node = el;
    while (node && node !== svg) {
      chain.push(node);
      node = node.parentNode;
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      const ancestor = chain[i];
      if (ancestor.transform && ancestor.transform.baseVal.numberOfItems > 0) {
        const m = ancestor.transform.baseVal.consolidate().matrix;
        matrix = matrix.multiply(new DOMMatrix([m.a, m.b, m.c, m.d, m.e, m.f]));
      }
    }
    return matrix;
  }

  function getPrefectureRootBBox(el) {
    const bbox = el.getBBox();
    const matrix = getLocalToRootMatrix(el);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const corners = [
      [bbox.x, bbox.y],
      [bbox.x + bbox.width, bbox.y],
      [bbox.x, bbox.y + bbox.height],
      [bbox.x + bbox.width, bbox.y + bbox.height],
    ];
    for (const [x, y] of corners) {
      const p = matrix.transformPoint(new DOMPoint(x, y));
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    return { minX, minY, maxX, maxY };
  }

  // 図形同士の隙間（重なっていれば 0）
  function bboxGap(a, b) {
    const dx = Math.max(a.minX - b.maxX, b.minX - a.maxX, 0);
    const dy = Math.max(a.minY - b.maxY, b.minY - a.maxY, 0);
    return Math.hypot(dx, dy);
  }

  function pointToBBoxDistance(box, x, y) {
    const dx = Math.max(box.minX - x, x - box.maxX, 0);
    const dy = Math.max(box.minY - y, y - box.maxY, 0);
    return Math.hypot(dx, dy);
  }

  function mergeBBox(a, b) {
    return {
      minX: Math.min(a.minX, b.minX),
      minY: Math.min(a.minY, b.minY),
      maxX: Math.max(a.maxX, b.maxX),
      maxY: Math.max(a.maxY, b.maxY),
    };
  }

  // 紙面の都合で本土から離れた離島（鹿児島の奄美・沖縄の宮古/八重山など）
  // を地図の別の場所にまとめて描いている県がある。要素全体の bbox で
  // ズームすると本土と離島の中間・地図の外まで含む範囲になってしまうため、
  // 県庁所在地ピンに最も近いパーツから、隣接する図形だけをつなげてズーム
  // 範囲とする（離れた離島は除外する）。
  const CLUSTER_GAP = 60;

  function getMainClusterBBox(el) {
    const shapes = Array.from(el.children).filter(
      (c) => c.tagName === "polygon" || c.tagName === "path"
    );
    if (shapes.length <= 1) return getPrefectureRootBBox(el);

    const boxes = shapes.map((c) => getPrefectureRootBBox(c));
    const pref = byCode.get(el.dataset.code);
    const pin = pref && pref.pin;
    let seedIdx = 0;
    if (pin) {
      let best = Infinity;
      boxes.forEach((b, i) => {
        const d = pointToBBoxDistance(b, pin.x, pin.y);
        if (d < best) {
          best = d;
          seedIdx = i;
        }
      });
    }

    let cluster = boxes[seedIdx];
    const remaining = boxes.filter((_, i) => i !== seedIdx);
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = remaining.length - 1; i >= 0; i--) {
        if (bboxGap(cluster, remaining[i]) <= CLUSTER_GAP) {
          cluster = mergeBBox(cluster, remaining[i]);
          remaining.splice(i, 1);
          changed = true;
        }
      }
    }
    return cluster;
  }

  function getZoomedViewBox(el) {
    const { minX, minY, maxX, maxY } = getMainClusterBBox(el);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    let size = Math.max(maxX - minX, maxY - minY) * ZOOM_PADDING;
    size = Math.min(Math.max(size, ZOOM_MIN_SIZE), FULL_VIEWBOX[2]);
    let x = cx - size / 2;
    let y = cy - size / 2;
    x = clamp(x, 0, Math.max(0, FULL_VIEWBOX[2] - size));
    y = clamp(y, 0, Math.max(0, FULL_VIEWBOX[3] - size));
    return [x, y, size, size];
  }

  // 指定した都道府県コード群をまとめて画面に収めるビューボックスを求める
  // （閲覧モードで「地方」単位に寄る用途）
  function getRegionViewBox(codes) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const code of codes) {
      const el = svg.querySelector(`.prefecture[data-code="${code}"]`);
      if (!el) continue;
      const b = getPrefectureRootBBox(el);
      minX = Math.min(minX, b.minX);
      minY = Math.min(minY, b.minY);
      maxX = Math.max(maxX, b.maxX);
      maxY = Math.max(maxY, b.maxY);
    }
    if (!Number.isFinite(minX)) return FULL_VIEWBOX.slice();
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    let size = Math.max(maxX - minX, maxY - minY) * 1.2;
    size = Math.min(Math.max(size, ZOOM_MIN_SIZE), FULL_VIEWBOX[2]);
    let x = cx - size / 2;
    let y = cy - size / 2;
    x = clamp(x, 0, Math.max(0, FULL_VIEWBOX[2] - size));
    y = clamp(y, 0, Math.max(0, FULL_VIEWBOX[3] - size));
    return [x, y, size, size];
  }

  function animateViewBox(target) {
    if (zoomAnimId) cancelAnimationFrame(zoomAnimId);
    const start = currentViewBox.slice();
    const startTime = performance.now();
    function step(now) {
      const t = Math.min(1, (now - startTime) / ZOOM_DURATION);
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const vb = start.map((s, i) => s + (target[i] - s) * eased);
      svg.setAttribute("viewBox", vb.join(" "));
      updateLabelFontScale(vb[2]);
      if (t < 1) {
        zoomAnimId = requestAnimationFrame(step);
      } else {
        currentViewBox = target.slice();
        zoomAnimId = null;
      }
    }
    zoomAnimId = requestAnimationFrame(step);
  }

  function zoomTo(code) {
    const el = svg.querySelector(`.prefecture[data-code="${code}"]`);
    if (!el) return;
    animateViewBox(getZoomedViewBox(el));
  }

  svg.addEventListener("pointerdown", (e) => {
    if (zoomAnimId) {
      cancelAnimationFrame(zoomAnimId);
      zoomAnimId = null;
    }
    if (activePointers.size === 0) {
      dragMoved = false;
      singleStartClientX = e.clientX;
      singleStartClientY = e.clientY;
    }
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      svg.setPointerCapture(e.pointerId);
    } catch (err) {
      // no-op: capture is best-effort, gesture tracking works without it
    }
    startGesture();
  });

  svg.addEventListener("pointermove", (e) => {
    if (!activePointers.has(e.pointerId)) return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (gestureMode === "pan") {
      const p = activePointers.get(e.pointerId);
      if (!dragMoved) {
        const d = Math.hypot(p.x - singleStartClientX, p.y - singleStartClientY);
        if (d > PAN_DRAG_THRESHOLD) dragMoved = true;
      }
      if (!dragMoved) return;
      e.preventDefault();
      setViewBoxCenteredOn(gestureAnchorMap, p.x, p.y, gestureViewBox[2]);
    } else if (gestureMode === "pinch") {
      const pts = Array.from(activePointers.values());
      if (pts.length < 2) return;
      e.preventDefault();
      const midX = (pts[0].x + pts[1].x) / 2;
      const midY = (pts[0].y + pts[1].y) / 2;
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const newSize = clamp(
        (gestureViewBox[2] * gestureStartDistance) / dist,
        MANUAL_ZOOM_MIN_SIZE,
        FULL_VIEWBOX[2]
      );
      setViewBoxCenteredOn(gestureAnchorMap, midX, midY, newSize);
    }
  });

  function endPointer(e) {
    if (!activePointers.has(e.pointerId)) return;
    const wasPan = gestureMode === "pan";
    activePointers.delete(e.pointerId);
    if (activePointers.size > 0) {
      startGesture(); // re-anchor from current viewBox so remaining finger doesn't jump
    } else {
      gestureMode = null;
      // Only a single-finger drag's pointerup synthesizes a trailing click to
      // swallow. A pinch (two fingers) never does, so don't flag it here —
      // that would wrongly eat the *next unrelated* tap. Auto-clear as a
      // safety net in case the expected click never arrives.
      if (wasPan && dragMoved) {
        suppressNextClick = true;
        setTimeout(() => {
          suppressNextClick = false;
        }, 400);
      }
    }
  }
  svg.addEventListener("pointerup", endPointer);
  svg.addEventListener("pointercancel", endPointer);

  svg.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (zoomAnimId) {
        cancelAnimationFrame(zoomAnimId);
        zoomAnimId = null;
      }
      const anchor = clientToMap(e.clientX, e.clientY, currentViewBox);
      // Per the WheelEvent spec, scrolling up (away from the user) is
      // deltaY < 0 — by map-app convention that should zoom IN (smaller box).
      const factor = Math.exp(e.deltaY * 0.0015);
      const newSize = clamp(currentViewBox[2] * factor, MANUAL_ZOOM_MIN_SIZE, FULL_VIEWBOX[2]);
      setViewBoxCenteredOn(anchor, e.clientX, e.clientY, newSize);
    },
    { passive: false }
  );

  function updateLabelsVisibility() {
    const showNames = namesToggle.checked;
    const showCapitals = capitalToggle.checked;
    const activeSet = new Set(activeCodes);
    prefLabelsEl.querySelectorAll(".pref-label").forEach((el) => {
      setSvgHidden(el, !showNames || !activeSet.has(el.dataset.code));
    });
    capitalLabelsEl.querySelectorAll(".capital-marker").forEach((el) => {
      setSvgHidden(el, !showCapitals || !activeSet.has(el.dataset.code));
    });
  }

  function startBrowseMode() {
    if (highlightedEl) {
      highlightedEl.style.fill = "";
      highlightedEl = null;
    }
    setSvgHidden(capitalPinEl, true);
    promptNameEl.hidden = true;
    questionTextEl.textContent = "";
    hintBtn.hidden = true;
    hintRevealEl.hidden = true;
    answerBox.hidden = true;
    hintTextEl.hidden = true;
    browseControlsEl.hidden = false;
    setSvgHidden(prefLabelsEl, false);
    setSvgHidden(capitalLabelsEl, false);
    updateLabelsVisibility();
    animateViewBox(getRegionViewBox(activeCodes));
  }

  function startMode(newMode) {
    mode = newMode;
    activeCodes = getActiveCodes();
    pool = [];
    lastCode = null;
    const regionLabel = getRegionLabel();
    modeLabelEl.textContent = regionLabel ? `${regionLabel}・${MODE_LABELS[mode]}` : MODE_LABELS[mode];
    screenStart.hidden = true;
    screenQuiz.hidden = false;

    if (mode === "browse") {
      startBrowseMode();
    } else if (mode === "tap") {
      browseControlsEl.hidden = true;
      setSvgHidden(prefLabelsEl, true);
      setSvgHidden(capitalLabelsEl, true);
      hintTextEl.hidden = false;
      startTapMode();
    } else {
      browseControlsEl.hidden = true;
      setSvgHidden(prefLabelsEl, true);
      setSvgHidden(capitalLabelsEl, true);
      hintTextEl.hidden = false;
      nextQuestion();
    }
  }

  function backToStart() {
    screenQuiz.hidden = true;
    screenStart.hidden = false;
    mode = null;
    if (zoomAnimId) {
      cancelAnimationFrame(zoomAnimId);
      zoomAnimId = null;
    }
    currentViewBox = FULL_VIEWBOX.slice();
    svg.setAttribute("viewBox", currentViewBox.join(" "));
    updateLabelFontScale(currentViewBox[2]);
    browseControlsEl.hidden = true;
    setSvgHidden(prefLabelsEl, true);
    setSvgHidden(capitalLabelsEl, true);
  }

  function nextQuestion() {
    currentCode = drawNextCode();
    showingAnswer = false;
    hintShown = false;
    render();
  }

  function reveal() {
    showingAnswer = true;
    render();
  }

  // タップモード: ランダム出題ではなく、地図をタップして選んだ都道府県が
  // そのまま問題になる。
  function startTapMode() {
    if (highlightedEl) {
      highlightedEl.style.fill = "";
      highlightedEl = null;
    }
    currentCode = null;
    showingAnswer = false;
    hintShown = false;
    setSvgHidden(capitalPinEl, true);
    promptNameEl.hidden = true;
    hintBtn.hidden = true;
    hintRevealEl.hidden = true;
    answerBox.hidden = true;
    hintTextEl.textContent = "";
    questionTextEl.textContent = TAP_IDLE_TEXT;
    animateViewBox(getRegionViewBox(activeCodes));
  }

  function selectTapTarget(code) {
    currentCode = code;
    showingAnswer = false;
    hintShown = false;
    render();
  }

  function deselectTapTarget() {
    currentCode = null;
    showingAnswer = false;
    hintShown = false;
    if (highlightedEl) {
      highlightedEl.style.fill = "";
      highlightedEl = null;
    }
    setSvgHidden(capitalPinEl, true);
    promptNameEl.hidden = true;
    hintBtn.hidden = true;
    hintRevealEl.hidden = true;
    answerBox.hidden = true;
    hintTextEl.textContent = "";
    questionTextEl.textContent = TAP_IDLE_TEXT;
    animateViewBox(getRegionViewBox(activeCodes));
  }

  // タップモードのタップ操作は「県をタップして選ぶ／どこをタップしても
  // 答えが開く／答えが開いたら次の県をタップする」という、他モードの
  // 「どこをタップしても進む」とは違う状態遷移になるため専用に処理する。
  function handleTapModeClick(e) {
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    if (currentCode && !showingAnswer) {
      reveal();
      return;
    }
    // svg 側で pointer capture しているため e.target は常に <svg> 自身に
    // なってしまう（キャプチャ中の合成 click イベントの仕様）。実際に
    // タップされた図形は座標から改めて調べる。
    const hitEl = document.elementFromPoint(e.clientX, e.clientY);
    const targetEl = hitEl && hitEl.closest && hitEl.closest(".prefecture");
    const tappedCode = targetEl && activeCodes.includes(targetEl.dataset.code) ? targetEl.dataset.code : null;
    if (tappedCode) {
      selectTapTarget(tappedCode);
    } else if (currentCode) {
      deselectTapTarget();
    }
  }

  function render() {
    const pref = byCode.get(currentCode);
    highlight(currentCode);
    // タップモードで答えを表示した後は、選んだ県にズームしたままにせず
    // 地方全体に戻して次にタップする県を選びやすくする
    if (mode === "tap" && showingAnswer) {
      animateViewBox(getRegionViewBox(activeCodes));
    } else {
      zoomTo(currentCode);
    }
    questionTextEl.textContent = QUESTION_TEXT[mode];

    // 県庁所在地が問われているモードでは、問題を出した時点からピンを表示する
    // （タップして次の問題に進むと、新しい県の位置に切り替わる）
    if (CAPITAL_PIN_MODES.has(mode) && pref.pin) {
      setSvgHidden(capitalPinEl, false);
      capitalPinEl.setAttribute("transform", `translate(${pref.pin.x}, ${pref.pin.y})`);
    } else {
      setSvgHidden(capitalPinEl, true);
    }

    if (mode === "capital") {
      promptNameEl.hidden = false;
      promptNameEl.textContent = pref.name;
    } else {
      promptNameEl.hidden = true;
      promptNameEl.textContent = "";
    }

    if (!showingAnswer) {
      answerBox.hidden = true;
      answerPrefEl.hidden = true;
      answerCapitalEl.hidden = true;
      hintTextEl.textContent = "タップして答えを見る";

      hintBtn.hidden = !HINT_MODES.has(mode) || hintShown;
      hintRevealEl.hidden = !hintShown;
      hintRevealEl.textContent = hintShown ? `ヒント: ${pref.hint}` : "";
      return;
    }

    hintBtn.hidden = true;
    hintRevealEl.hidden = true;
    answerBox.hidden = false;
    hintTextEl.textContent = "タップして次へ";

    if (mode === "pref" || mode === "both" || mode === "tap") {
      answerPrefEl.hidden = false;
      answerPrefEl.innerHTML = `${pref.name}<span class="kana">${pref.kana}</span>`;
    } else {
      answerPrefEl.hidden = true;
    }

    if (mode === "capital" || mode === "both" || mode === "tap") {
      answerCapitalEl.hidden = false;
      answerCapitalEl.innerHTML = `${pref.capital}<span class="kana">${pref.capitalKana}</span>`;
    } else {
      answerCapitalEl.hidden = true;
    }
  }

  tapArea.addEventListener("click", (e) => {
    if (mode === "tap") {
      handleTapModeClick(e);
      return;
    }
    if (!QUIZ_MODES.has(mode)) return; // 閲覧モードにはタップで進む操作がない
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    if (showingAnswer) {
      nextQuestion();
    } else {
      reveal();
    }
  });

  hintBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    hintShown = true;
    render();
  });

  namesToggle.addEventListener("change", updateLabelsVisibility);
  capitalToggle.addEventListener("change", updateLabelsVisibility);

  backBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    backToStart();
  });

  document.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => startMode(btn.dataset.mode));
  });
})();
