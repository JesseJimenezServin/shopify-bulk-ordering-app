(function () {
  var widgets = document.querySelectorAll('.nuvus-drop');

  // Must match the app's deployed application_url — a relative path won't
  // work here since this script runs on the storefront domain, not the app's.
  var NUVUS_API_BASE = 'https://nuvus-kohl.vercel.app';
  var POLL_INTERVAL_MS = 4000;

  widgets.forEach(function (widget) {
    var productId = widget.dataset.productId;
    var variantId = widget.dataset.variantId;
    var goal = parseInt(widget.dataset.poolGoal, 10) || 20;
    var deadlineIso = widget.dataset.deadline;
    var deadlineMs = deadlineIso ? new Date(deadlineIso).getTime() : null;

    var fillEl = widget.querySelector('[data-nuvus-fill]');
    var countEl = widget.querySelector('[data-nuvus-count]');
    var timerEl = widget.querySelector('[data-nuvus-timer]');
    var statusEl = widget.querySelector('[data-nuvus-status]');
    var tickerEl = widget.querySelector('[data-nuvus-ticker]');
    var reserveBtn = widget.querySelector('[data-nuvus-reserve]');

    var poolLocked = false;

    function formatCountdown(msRemaining) {
      if (msRemaining <= 0) return '0:00';
      var totalSec = Math.floor(msRemaining / 1000);
      var m = Math.floor(totalSec / 60);
      var s = totalSec % 60;
      return m + ':' + (s < 10 ? '0' : '') + s;
    }

    function lockPool(reason) {
      if (poolLocked) return;
      poolLocked = true;
      reserveBtn.disabled = true;
      reserveBtn.textContent = reason === 'goal_reached'
        ? '✅ GOAL REACHED — LOCKING IN'
        : '⏱ POOL CLOSED';
      statusEl.textContent = reason === 'goal_reached'
        ? 'Unlocked! Processing orders...'
        : 'Missed — no one was charged';
    }

    function tickCountdown() {
      if (!deadlineMs) return;
      var remaining = deadlineMs - Date.now();
      timerEl.textContent = formatCountdown(remaining);
      if (remaining <= 0) {
        lockPool('deadline_passed');
      }
    }

    function renderTicker(recent) {
      if (!recent || !recent.length) return;
      var entry = recent[recent.length - 1];
      tickerEl.textContent = entry.label;
      tickerEl.classList.remove('nuvus-drop__ticker--pulse');
      requestAnimationFrame(function () {
        tickerEl.classList.add('nuvus-drop__ticker--pulse');
      });
    }

    function pollStatus() {
      fetch(NUVUS_API_BASE + '/api/pool-status?productId=' + encodeURIComponent(productId) + '&variantId=' + encodeURIComponent(variantId))
        .then(function (res) { return res.json(); })
        .then(function (data) {
          var current = data.current || 0;
          var pct = Math.min(100, Math.round((current / goal) * 100));
          fillEl.style.width = pct + '%';
          countEl.textContent = current;
          renderTicker(data.recent);

          if (data.status === 'reached') lockPool('goal_reached');
          if (data.status === 'missed') lockPool('deadline_passed');
        })
        .catch(function (err) {
          console.warn('NUVUS pool-status fetch failed', err);
        });
    }

    reserveBtn.addEventListener('click', function () {
      if (poolLocked) return;
      reserveBtn.disabled = true;
      reserveBtn.textContent = 'Reserving...';

      fetch('/cart/add.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ id: variantId, quantity: 1 }] })
      })
        .then(function (res) {
          if (!res.ok) throw new Error('cart/add failed');
          window.location.href = '/checkout';
        })
        .catch(function (err) {
          console.error(err);
          reserveBtn.disabled = false;
          reserveBtn.textContent = 'RESERVE SPOT — try again';
        });
    });

    pollStatus();
    setInterval(pollStatus, POLL_INTERVAL_MS);
    setInterval(tickCountdown, 1000);
    tickCountdown();
  });
})();
