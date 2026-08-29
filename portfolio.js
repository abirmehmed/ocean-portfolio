/**
 * Portfolio shell — panel navigation, the Work carousel, contact form,
 * and case-study modal. Deliberately has ZERO dependency on the ocean
 * engine (ocean.js): no references to renderer/scene/camera/U/THREE.
 * That means it runs unconditionally, whether or not WebGPU/the ocean
 * itself is available (see main.js).
 */

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const PANEL_ORDER = ['home', 'about', 'skills', 'work', 'contact'];
let currentPanelIndex = 0;
const panelsMap = {};
let panelNavButtons = [];

function goToPanelIndex(index) {
  const clamped = Math.max(0, Math.min(PANEL_ORDER.length - 1, index));
  const name = PANEL_ORDER[clamped];
  const target = panelsMap[name];
  if (!target) return;

  currentPanelIndex = clamped;
  if (!target.classList.contains('active')) {
    Object.values(panelsMap).forEach((el) => el.classList.remove('active'));
    target.classList.add('active');
  }
  panelNavButtons.forEach((btn) => btn.setAttribute('aria-pressed', String(btn.dataset.panel === name)));

  if (carouselApi) {
    if (name === 'work') carouselApi.start(); else carouselApi.stop();
  }
}

function setupPanelNav() {
  panelNavButtons = Array.from(document.querySelectorAll('[data-panel]'));
  document.querySelectorAll('.content-panel').forEach((el) => {
    panelsMap[el.dataset.panelContent] = el;
  });

  panelNavButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = PANEL_ORDER.indexOf(btn.dataset.panel);
      if (idx !== -1) goToPanelIndex(idx);
    });
  });

  let wheelCooldown = false;
  window.addEventListener('wheel', (e) => {
    const modal = document.getElementById('caseModal');
    if (modal && modal.classList.contains('open')) return; // let the modal scroll normally

    const hoveredPanel = e.target.closest && (e.target.closest('.content-panel') || e.target.closest('#panel'));
    if (hoveredPanel && hoveredPanel.scrollHeight > hoveredPanel.clientHeight + 1) return; // let it scroll internally

    e.preventDefault();
    e.stopPropagation();
    if (wheelCooldown || Math.abs(e.deltaY) < 12) return;
    wheelCooldown = true;
    setTimeout(() => { wheelCooldown = false; }, 750);
    goToPanelIndex(currentPanelIndex + (e.deltaY > 0 ? 1 : -1));
  }, { passive: false, capture: true });

  goToPanelIndex(0); // sync aria-pressed for the default (Home) tab
}

// -------------------------------------------------------------------------
// Work: a data-driven set of project cards. Add more projects here later —
// the rotator below adapts automatically, no HTML editing required.
// -------------------------------------------------------------------------
const PROJECTS = [
  {
    tag: 'WebGPU',
    title: 'Open Sea',
    description: "A real-time procedural ocean — Gerstner waves, analytic normals, TSL bloom, and a shared analytic sky. The page you're on right now.",
    linkText: 'This page →',
    href: null,
    image: null,
    features: [
      'Five Gerstner waves with analytic (not neighbor-sampled) normals',
      'Procedural sky, sun, clouds, and rain/thunder — no textures or video',
      'TSL bloom, ACES tone mapping, day/night and sea-state controls'
    ]
  },
  {
    tag: 'Laravel · Livewire · PHP',
    title: 'UniMart',
    description: 'A full-stack POS (point of sale) application built with Laravel and Livewire.',
    linkText: 'View demo →',
    href: 'https://uni-mart.onrender.com/',
    image: 'thumb-unimart.jpg',
    features: [
      'Live inventory sync across the product catalog',
      'Shopping cart with add-to-cart flow',
      'Staff login for point-of-sale access'
    ]
  },
  {
    tag: 'React · Express',
    title: 'Sonix Store',
    description: 'A full-stack e-commerce store built with React.js on the frontend and Express on the backend.',
    linkText: 'View demo →',
    href: 'https://sonix-store.vercel.app/',
    image: 'thumb-sonix.jpg',
    features: [
      'Product detail page with pricing and discounts',
      'Customer ratings and review counts',
      'Cart and checkout flow'
    ]
  },
  {
    tag: 'Coming Soon',
    title: 'Next Project',
    description: 'Something new is in the works — check back soon, or ask me about it directly.',
    linkText: null,
    href: null,
    image: null,
    features: []
  }
];

// A real sliding carousel — up to 3 cards physically move, with clones
// padding both ends of the track so it loops seamlessly forward AND
// backward (the standard infinite-carousel technique: slide past the
// clones, then snap invisibly back into the real range with the
// transition switched off for that one frame). Auto-advances every 3s
// while the Work panel is active (paused on hover/manual interaction/
// hidden tab, skipped under reduced motion). Shows 1 card at a time on
// narrow screens, 3 on wider ones.
const CAROUSEL_GAP = 14;
let carouselApi = null;

function setupCarousel() {
  const rotator = document.getElementById('workRotator');
  const dotsWrap = document.getElementById('carouselDots');
  const prevBtn = document.getElementById('carouselPrev');
  const nextBtn = document.getElementById('carouselNext');
  const N = PROJECTS.length;
  if (!rotator || !dotsWrap || !prevBtn || !nextBtn || N === 0) return;

  const w = Math.min(window.innerWidth < 700 ? 1 : 3, N);

  const track = document.createElement('div');
  track.className = 'work-track';
  rotator.appendChild(track);

  function buildSlide() {
    const slide = document.createElement('div');
    slide.className = 'carousel-slide';
    slide.style.flex = `0 0 calc((100% - ${(w - 1) * CAROUSEL_GAP}px) / ${w})`;
    slide.innerHTML =
      '<div class="card-thumb"><img alt="" /></div>' +
      '<div class="card-body">' +
      '<div class="card-head"><span class="tag"></span><span class="live-badge"><span class="status-dot" aria-hidden="true"></span>Live</span></div>' +
      '<h3></h3><p></p>' +
      '<div class="card-links"><a class="demo-link" target="_blank" rel="noopener noreferrer"></a><button type="button" class="case-link">Details →</button></div>' +
      '</div>';
    return slide;
  }

  function fillSlide(slide, project) {
    const thumb = slide.querySelector('.card-thumb');
    const img = slide.querySelector('.card-thumb img');
    if (project.image) {
      img.src = project.image;
      img.alt = `${project.title} screenshot`;
      thumb.style.display = '';
    } else {
      thumb.style.display = 'none';
    }
    slide.querySelector('.tag').textContent = project.tag;
    slide.querySelector('.live-badge').style.visibility = project.href ? 'visible' : 'hidden';
    slide.querySelector('h3').textContent = project.title;
    slide.querySelector('p').textContent = project.description;
    slide.querySelector('.case-link').addEventListener('click', () => openCaseModal(project));
    const link = slide.querySelector('.demo-link');
    if (!project.linkText) {
      link.style.display = 'none';
    } else {
      link.style.display = '';
      link.textContent = project.linkText;
    }
    if (project.href) {
      link.href = project.href;
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    } else {
      link.removeAttribute('href');
      link.removeAttribute('target');
      link.removeAttribute('rel');
    }
  }

  // Track order: [leading clones of the last w] + [real items] + [trailing clones of the first w]
  const order = [];
  for (let i = N - w; i < N; i++) order.push(i);
  for (let i = 0; i < N; i++) order.push(i);
  for (let i = 0; i < w; i++) order.push(i);

  const slideEls = order.map((projectIndex) => {
    const slide = buildSlide();
    fillSlide(slide, PROJECTS[projectIndex]);
    track.appendChild(slide);
    return slide;
  });

  PROJECTS.forEach((_, i) => {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.setAttribute('aria-label', `Show project ${i + 1}`);
    dot.addEventListener('click', () => { goTo(w + i); restart(); });
    dotsWrap.appendChild(dot);
  });
  const dots = Array.from(dotsWrap.children);

  let index = w; // first real item
  let animating = false;
  let autoplayTimer = null;

  function stepPx() {
    return slideEls[0].getBoundingClientRect().width + CAROUSEL_GAP;
  }

  function apply(withTransition) {
    track.style.transition = withTransition ? 'transform 0.6s cubic-bezier(0.22, 0.8, 0.32, 1)' : 'none';
    track.style.transform = `translateX(-${index * stepPx()}px)`;
  }

  function updateDots() {
    const realIndex = ((index - w) % N + N) % N;
    dots.forEach((d, i) => d.classList.toggle('active', i === realIndex));
  }

  function goTo(newIndex) {
    if (animating || N <= 1) return;
    animating = true;
    index = newIndex;
    apply(true);
    updateDots();
  }

  track.addEventListener('transitionend', (e) => {
    if (e.propertyName !== 'transform') return;
    animating = false;
    if (index >= w + N) { index -= N; apply(false); }
    else if (index < w) { index += N; apply(false); }
  });

  function next() { goTo(index + 1); }
  function prev() { goTo(index - 1); }

  function stop() {
    if (autoplayTimer) { clearInterval(autoplayTimer); autoplayTimer = null; }
  }
  function start() {
    stop();
    if (prefersReducedMotion || N <= 1) return;
    autoplayTimer = setInterval(next, 3000);
  }
  function restart() {
    if (panelsMap.work && panelsMap.work.classList.contains('active')) start();
  }

  prevBtn.addEventListener('click', () => { prev(); restart(); });
  nextBtn.addEventListener('click', () => { next(); restart(); });
  rotator.addEventListener('mouseenter', stop);
  rotator.addEventListener('mouseleave', restart);
  window.addEventListener('resize', () => apply(false));

  apply(false);
  updateDots();
  carouselApi = { start, stop, restart };
}

// -------------------------------------------------------------------------
// Contact form: no backend on GitHub Pages, so this posts to FormSubmit's
// AJAX endpoint (formsubmit.co) using the real inbox address — no signup
// required, but FormSubmit sends a one-time confirmation email on the
// very first submission that has to be clicked before messages actually
// arrive. Includes a hidden honeypot field as basic spam protection.
// -------------------------------------------------------------------------
function setupContactForm() {
  const form = document.getElementById('contactForm');
  const statusEl = document.getElementById('formStatus');
  if (!form || !statusEl) return;

  const submitBtn = form.querySelector('.form-submit');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const honey = form.querySelector('[name="_honey"]').value;
    if (honey) return; // bot filled the hidden field — silently drop

    const name = form.querySelector('#cf-name').value.trim();
    const email = form.querySelector('#cf-email').value.trim();
    const message = form.querySelector('#cf-message').value.trim();

    if (!name || !email || !message) {
      statusEl.textContent = 'Please fill in all fields.';
      statusEl.className = 'form-status error';
      return;
    }

    submitBtn.disabled = true;
    statusEl.textContent = 'Sending…';
    statusEl.className = 'form-status pending';

    try {
      const res = await fetch('https://formsubmit.co/ajax/abirmehmed@gmail.com', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ name, email, message, _subject: 'New message from your portfolio' })
      });
      if (!res.ok) throw new Error('Request failed');
      statusEl.textContent = "Sent — I'll get back to you soon.";
      statusEl.className = 'form-status success';
      form.reset();
    } catch (err) {
      statusEl.textContent = 'Something went wrong — try the email link below instead.';
      statusEl.className = 'form-status error';
    } finally {
      submitBtn.disabled = false;
    }
  });
}

// -------------------------------------------------------------------------
// Case-study modal: a single reusable dialog, populated from whichever
// project's "Details" button was clicked. Closes on Escape, backdrop
// click, or the close button, and returns focus to whatever triggered it.
// -------------------------------------------------------------------------
let caseModalLastFocus = null;

function openCaseModal(project) {
  const modal = document.getElementById('caseModal');
  if (!modal) return;

  const thumb = modal.querySelector('.case-modal-thumb');
  const img = modal.querySelector('.case-modal-thumb img');
  if (project.image) {
    img.src = project.image;
    img.alt = `${project.title} screenshot`;
    thumb.style.display = '';
  } else {
    thumb.style.display = 'none';
  }
  modal.querySelector('#caseModalTag').textContent = project.tag;
  modal.querySelector('#caseModalTitle').textContent = project.title;
  modal.querySelector('#caseModalDesc').textContent = project.description;

  const featuresEl = modal.querySelector('#caseModalFeatures');
  featuresEl.innerHTML = '';
  (project.features || []).forEach((f) => {
    const li = document.createElement('li');
    li.textContent = f;
    featuresEl.appendChild(li);
  });

  const link = modal.querySelector('#caseModalLink');
  link.textContent = project.linkText;
  if (project.href) {
    link.href = project.href;
    link.style.display = '';
  } else {
    link.style.display = 'none';
  }

  caseModalLastFocus = document.activeElement;
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  modal.querySelector('.case-modal-close').focus();
  document.addEventListener('keydown', onCaseModalKeydown);
}

function closeCaseModal() {
  const modal = document.getElementById('caseModal');
  if (!modal) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  document.removeEventListener('keydown', onCaseModalKeydown);
  if (caseModalLastFocus) caseModalLastFocus.focus();
}

function onCaseModalKeydown(e) {
  if (e.key === 'Escape') closeCaseModal();
}

function setupCaseModal() {
  const modal = document.getElementById('caseModal');
  if (!modal) return;
  modal.querySelectorAll('[data-close]').forEach((el) => {
    el.addEventListener('click', closeCaseModal);
  });
}

// -------------------------------------------------------------------------
// Public entry point — called unconditionally from main.js. Registers its
// own visibilitychange listener (independent from ocean.js's) so the
// carousel autoplay pauses/resumes on tab visibility without any import
// between the two modules — the browser supports multiple listeners on
// the same event fine.
// -------------------------------------------------------------------------
export function initPortfolio() {
  setupPanelNav();
  setupCarousel();
  setupContactForm();
  setupCaseModal();

  document.addEventListener('visibilitychange', () => {
    if (!carouselApi) return;
    if (document.hidden) carouselApi.stop();
    else carouselApi.restart();
  });
}
