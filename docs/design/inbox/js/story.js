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

  /** Draws one real card with numbered pins on its slots. */
  function drawAnatomy() {
    var host = document.getElementById('anat');
    var e = World.buildEntities().filter(function (x) { return x.id === 'pr-6238'; })[0];
    var card = Frames.drawLooseCard(e);
    host.appendChild(card);
    var pins = [['.c-mark', 0, 10], ['.c-title', 0.12, 0], ['.c-pace', 0.5, 0], ['.c-line .person', 0.5, 0], ['.c-roll', 0.6, 0], ['.c-more', 0.5, 0], ['.c-status', 0.5, 0], ['.c-id', 0.3, 0], ['.c-facts', 0.3, 0]];
    var base = card.getBoundingClientRect();
    var zoom = base.width / card.offsetWidth;
    pins.forEach(function (p, i) {
      var el = card.querySelector(p[0]);
      if (!el) return;
      var r = el.getBoundingClientRect();
      var pin = document.createElement('i');
      pin.className = 'anat-pin';
      pin.textContent = i + 1;
      pin.style.left = ((r.left - base.left + r.width * p[1]) / zoom) + 'px';
      pin.style.top = ((r.top - base.top) / zoom - 3) + 'px';
      host.appendChild(pin);
    });
  }

  function drawShapes() {
    var words = { ring: 'Open, not started', dashed: 'Not real yet: draft, backlog, triage', quarter: 'Started', half: 'Half way', most: 'Nearly there', fork: 'A proposed change', join: 'Merged', check: 'Finished well', cross: 'Failed or refused', alert: 'Burning' };
    document.getElementById('shapes').innerHTML = Object.keys(Kinds.SHAPES).map(function (k) {
      return '<div>' + Card.drawShape({ shape: k, tone: 'quiet', word: k }, 18) + '<span>' + words[k] + '</span></div>';
    }).join('');
  }

  var STATES = [['02-peek', 'Peek'], ['03-open', 'Open card'], ['04-open-noticed', 'What Hercule noticed, open'], ['05-menu', 'Several workflows fit'], ['06-handed', 'Handed and taken'], ['08-carrying', 'Carrying a card to a colleague'], ['09-light-day', 'A light day'], ['10-300-cards', '300 cards'], ['11-tray', 'A pile fanned open'], ['12-long-and-huge', 'A very long title'], ['13-loading', 'Loading'], ['14-offline', 'Offline'], ['15-github-failing', 'GitHub failing'], ['16-inbox-zero', 'Inbox zero'], ['17-first-run', 'First run']];

  function drawGallery() {
    document.getElementById('gal').innerHTML = STATES.map(function (s) {
      var src = 'screens/' + root.dataset.theme + '/' + s[0] + '.webp';
      return '<a href="' + src + '" target="_blank"><img loading="lazy" src="' + src + '" alt="' + s[1] + '">' + s[1] + '</a>';
    }).join('');
  }

  drawAnatomy();
  Frames.drawKinds(document.getElementById('kinds'));
  drawShapes();
  drawGallery();
})();
