/**
 * Aurora 极光音乐 —— 流畅拖拽排序（HTML5 DnD + FLIP 动画）
 */
(function () {
  'use strict';

  function flip(container, mutate) {
    const items = Array.from(container.children);
    const first = new Map();
    for (const el of items) first.set(el, el.getBoundingClientRect());
    mutate();
    for (const el of items) {
      const a = first.get(el);
      const b = el.getBoundingClientRect();
      const dy = a.top - b.top;
      if (Math.abs(dy) > 1) {
        try {
          el.animate(
            [{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }],
            { duration: 230, easing: 'cubic-bezier(.2,.85,.25,1)' }
          );
        } catch { /* ignore */ }
      }
    }
  }

  /**
   * @param {HTMLElement} container 列表容器
   * @param {object} opts { itemSelector, handleSelector, scrollParent, onReorder(items)->ids, onDrop }
   */
  function makeSortable(container, opts = {}) {
    const itemSel = opts.itemSelector || '[data-id]';
    const state = { dragEl: null, startOrder: [], active: false };

    function items() { return Array.from(container.querySelectorAll(itemSel)); }

    container.addEventListener('dragstart', (e) => {
      const el = e.target.closest(itemSel);
      if (!el || !container.contains(el)) return;
      // 按钮等交互控件上不启动拖拽，保证它们的点击照常工作
      const exSel = opts.excludeSelector === undefined ? 'button, a, input, select, textarea' : opts.excludeSelector;
      if (exSel && e.target.closest(exSel)) { e.preventDefault(); return; }
      // 指定了抓手时只允许从抓手开始拖拽；不指定则整行都可拖
      if (opts.handleSelector && !e.target.closest(opts.handleSelector)) { e.preventDefault(); return; }
      state.dragEl = el;
      state.active = true;
      state.startOrder = items().map((x) => x.dataset.id);
      el.classList.add('dragging');
      container.classList.add('drag-active');
      try {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', el.dataset.id || '');
      } catch { /* ignore */ }
    });

    container.addEventListener('dragend', () => {
      if (state.dragEl) state.dragEl.classList.remove('dragging');
      container.classList.remove('drag-active');
      for (const el of items()) el.classList.remove('drop-above', 'drop-below');
      if (state.active) {
        const order = items().map((x) => x.dataset.id);
        const changed = order.join(',') !== state.startOrder.join(',');
        if (changed && opts.onReorder) opts.onReorder(order);
        if (opts.onDrop) opts.onDrop(order, changed);
      }
      state.active = false;
      state.dragEl = null;
    });

    container.addEventListener('dragover', (e) => {
      if (!state.dragEl) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const target = e.target.closest(itemSel);
      if (!target || target === state.dragEl) return;
      const rect = target.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      for (const el of items()) el.classList.remove('drop-above', 'drop-below');
      target.classList.add(after ? 'drop-below' : 'drop-above');
      const reference = after ? target.nextSibling : target;
      if (reference === state.dragEl || (reference && reference === state.dragEl.nextSibling)) return;
      flip(container, () => {
        container.insertBefore(state.dragEl, reference);
      });
      autoScroll(e);
    });

    container.addEventListener('drop', (e) => { if (state.dragEl) e.preventDefault(); });

    function autoScroll(e) {
      const sp = opts.scrollParent || container.closest('.view-body') || container.parentElement;
      if (!sp) return;
      const r = sp.getBoundingClientRect();
      const edge = 56;
      if (e.clientY < r.top + edge) sp.scrollTop -= Math.max(4, (r.top + edge - e.clientY) / 2.4);
      else if (e.clientY > r.bottom - edge) sp.scrollTop += Math.max(4, (e.clientY - (r.bottom - edge)) / 2.4);
    }

    return {
      refresh() { /* 占位：列表重绘后无需重新绑定（事件委托） */ },
      destroy() { state.active = false; state.dragEl = null; }
    };
  }

  /** 通用浮层拖拽（用于浮动板块 / 迷你窗口） */
  function makeDraggable(panel, handle, opts = {}) {
    let sx = 0; let sy = 0; let ox = 0; let oy = 0; let dragging = false;
    const h = handle || panel;
    h.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, input, select, .no-drag')) return;
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      const r = panel.getBoundingClientRect();
      ox = r.left; oy = r.top;
      h.setPointerCapture(e.pointerId);
      panel.style.transition = 'none';
    });
    h.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const nx = ox + (e.clientX - sx);
      const ny = oy + (e.clientY - sy);
      panel.style.left = `${Math.max(-40, Math.min(window.innerWidth - 60, nx))}px`;
      panel.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, ny))}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    });
    h.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      try { h.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      if (opts.onMove) opts.onMove(panel.getBoundingClientRect());
    });
  }

  window.DragSort = { makeSortable, makeDraggable, flip };
})();
