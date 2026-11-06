// The story page: fits live frames of the window into the page, keeps them on the chosen theme, and draws the real pieces.
(function () {
  var root = document.documentElement;
  var pick = document.getElementById('theme');
  var frames = [].slice.call(document.querySelectorAll('.frame'));

  function frameUrl(f) {
    return 'desktop.html?theme=' + root.dataset.theme + '&dock=0&' + (f.dataset.q || 'live=0');
  }

  /** Scales a frame's window so that the whole window fits the frame's width. */
  function fit(f) {
    var w = Number(f.dataset.w) || 1440, h = Number(f.dataset.h) || 900;
    var iframe = f.querySelector('iframe');
    var scale = f.clientWidth / w;
    f.style.height = Math.round(h * scale) + 'px';
    if (!iframe) return;
    iframe.style.width = w + 'px';
    iframe.style.height = h + 'px';
    iframe.style.transform = 'scale(' + scale + ')';
  }

  function mount(f) {
    if (f.querySelector('iframe')) return;
    var iframe = document.createElement('iframe');
    iframe.src = frameUrl(f);
    iframe.title = f.getAttribute('aria-label') || 'The Inbox';
    f.appendChild(iframe);
    fit(f);
  }

  var seen = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { if (e.isIntersecting) mount(e.target); });
  }, { rootMargin: '400px' });
  frames.forEach(function (f) { fit(f); seen.observe(f); });
  window.addEventListener('resize', function () { frames.forEach(fit); });

  pick.value = root.dataset.theme;
  pick.addEventListener('change', function () {
    root.dataset.theme = pick.value;
    frames.forEach(function (f) { var i = f.querySelector('iframe'); if (i) i.src = frameUrl(f); });
    drawGallery();
  });

  // The buttons under a frame send the window a command.
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-send]');
    if (!b) return;
    var target = document.getElementById(b.dataset.to).querySelector('iframe');
    if (target) target.contentWindow.postMessage(JSON.parse(b.dataset.send), '*');
  });

  function drawShapes() {
    var words = { ring: 'Open, not started', dashed: 'Not real yet: draft, backlog, triage', quarter: 'Started', half: 'Half way', most: 'Nearly there', fork: 'A proposed change', join: 'Merged', check: 'Finished well', cross: 'Failed or refused', hold: 'Waits for a change', alert: 'Burning' };
    document.getElementById('shapes').innerHTML = Object.keys(Kinds.SHAPES).map(function (k) {
      return '<div>' + Card.drawShape({ shape: k, tone: 'quiet', word: k }, 18) + '<span>' + words[k] + '</span></div>';
    }).join('');
  }

  var STATES = [['02-hover', 'A request, reached for'], ['03-open', 'A ticket, open'], ['11-open-project', 'A project, open'], ['04-open-noticed', 'What Hercule noticed, open'], ['20-link-hint', 'A hint, waiting to be confirmed'], ['21-by-initiative', 'Grouped by initiative'], ['05-menu', 'Several workflows fit'], ['06-handed', 'Handed and taken'], ['07-signal-landing', 'A signal on a linked row'], ['08-carrying', 'Carrying a card'], ['09-light-day', 'A light day'], ['10-300-cards', '300 cards'], ['12-long-and-huge', 'A very long title'], ['13-loading', 'Loading'], ['14-offline', 'Offline'], ['15-github-failing', 'A failing source'], ['19-requests-clear', 'No requests left'], ['16-inbox-zero', 'Inbox zero'], ['17-first-run', 'First run'], ['18-intake', 'Intake']];

  function drawGallery() {
    document.getElementById('gal').innerHTML = STATES.map(function (s) {
      var src = 'screens/' + root.dataset.theme + '/' + s[0] + '.webp';
      return '<a href="' + src + '" target="_blank"><img loading="lazy" src="' + src + '" alt="' + s[1] + '">' + s[1] + '</a>';
    }).join('');
  }

  Frames.drawKinds(document.getElementById('kinds'));
  drawShapes();
  drawGallery();
})();
