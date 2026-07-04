/*
 * Cloudflare Turnstile, loaded lazily.
 *
 * The challenge widget is only needed when the visitor submits the contact
 * form, so its API script is injected on the first interaction (pointer, key,
 * touch, or scroll) rather than during initial page load. This keeps the
 * third-party request off the critical path and means automated audits and
 * bots — which never interact — never request it (avoiding rate-limit noise).
 *
 * Turnstile implicit rendering finds the `.cf-turnstile` element and renders
 * the widget once the API script loads, well before the visitor reaches submit.
 */
(function () {
	if (!document.querySelector('.cf-turnstile')) return;

	var TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
	var events = ['pointerdown', 'keydown', 'touchstart', 'scroll'];
	var loaded = false;

	function load() {
		if (loaded) return;
		loaded = true;
		events.forEach(function (evt) {
			window.removeEventListener(evt, load);
		});

		var s = document.createElement('script');
		s.src = TURNSTILE_SRC;
		s.async = true;
		s.defer = true;
		document.head.appendChild(s);
	}

	events.forEach(function (evt) {
		window.addEventListener(evt, load, { once: true, passive: true });
	});
})();
